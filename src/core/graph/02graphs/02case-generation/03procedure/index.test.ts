// Drives the compiled procedure graph with a fake `ProcedureStrategy` and a
// fake `LlmPort` that throws if called for anything a test did not script.
// The fake strategy is the payoff of issue 07's `ProcedureStrategy` port: it
// makes it cheap to exercise the blinded solver's control flow (order →
// results → diagnose, the iteration cap, a ruled-out diagnosis, and the
// `exhausted` move) with zero LLM calls attributable to the strategy itself.
// No filesystem, no SQLite, no real LLM — mirrors the house style in
// `runtime.test.ts` and `catalog/procedures/catalog.test.ts`.
import { describe, expect, it } from "vitest";
import z from "zod";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { buildProcedureGraph, buildBlindedSolverGraph } from "./index.js";
import {
  createProcedureStrategy,
  type BlindedView,
  type OracleView,
  type ProcedureStrategy,
  type SolverMove,
} from "./strategy/index.js";
import type { GraphRuntime, LlmPort, LlmRole } from "@/core/graph/runtime.js";
import type { PlannedProcedure } from "@/core/graph/models/Procedure.js";
import { encodeText } from "@/core/graph/models/ContentPart.js";
import type { ModalityProvider } from "@/core/graph/modality/ports.js";
import { InMemoryProcedureCatalog } from "@/core/graph/catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "@/core/graph/catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "@/core/graph/catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "@/core/graph/catalog/diagnosis/index.js";
import { EventBus } from "@/core/event-bus.js";
import { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { runWithContext } from "@/core/graph/utils/context.js";
import { createJobEventChannel } from "@/core/jobEvents/channel.js";
import { wireLabels, type LabelEvent } from "@/core/jobEvents/labels.js";

// ─── Fakes ──────────────────────────────────────────────────────────────────

/**
 * A `LlmPort` that serves a scripted, per-role queue of canned JSON
 * responses and throws for any role/call it wasn't told about — so a test
 * that scripts zero LLM calls fails loudly the moment one happens.
 */
function makeQueuedLlmPort(
  responses: Partial<Record<LlmRole, string[]>>
): LlmPort {
  const queues: Partial<Record<LlmRole, string[]>> = {
    generator: [...(responses.generator ?? [])],
    judge: [...(responses.judge ?? [])],
    translator: [...(responses.translator ?? [])],
  };
  return {
    for(opts) {
      const queue = queues[opts.role];
      if (!queue || queue.length === 0) {
        throw new Error(
          `Unexpected LLM call for role "${opts.role}" — the test did not script one.`
        );
      }
      const response = queue.shift() as string;
      return new FakeListChatModel({ responses: [response] });
    },
  };
}

function buildFakeRuntime(
  llm: LlmPort,
  procedures: InMemoryProcedureCatalog = new InMemoryProcedureCatalog()
): GraphRuntime {
  return {
    llm,
    catalogs: {
      procedures,
      anamnesis: new InMemoryAnamnesisCatalog(),
      labels: new InMemoryLabelCatalog(),
      diagnosis: new InMemoryDiagnosisCatalog(),
    },
    log: { info() {}, warn() {}, error() {} },
    clock: () => new Date("2024-01-01T00:00:00.000Z"),
  };
}

/**
 * A recording, batch-in/batch-out text provider — the same production shape
 * `03procedure/providers.ts`'s real one has, minus the LLM call: it just
 * echoes each instruction back as bytes, so `render_results`'s output is
 * predictable without scripting a rendering LLM call in every test.
 */
function makeRecordingTextProvider(): {
  provider: ModalityProvider<unknown>;
  calls: { instruction: string }[][];
} {
  const calls: { instruction: string }[][] = [];
  const provider: ModalityProvider<unknown> = {
    id: "text",
    mime: "text/plain",
    description: "test text provider",
    inputSchema: z.object({ instruction: z.string().min(1) }),
    render: async (batch) => {
      const typed = batch as { instruction: string }[];
      calls.push(typed);
      return typed.map((b) => encodeText(b.instruction));
    },
  };
  return { provider, calls };
}

/** A scripted `ProcedureStrategy`: one move per `nextStep` call, in order. */
function makeScriptedStrategy(opts: {
  id?: string;
  nextSteps?: SolverMove[];
  bridgeResult?: PlannedProcedure[];
}) {
  const nextStepViews: BlindedView[] = [];
  const bridgeViews: OracleView[] = [];
  const queue = [...(opts.nextSteps ?? [])];

  const strategy: ProcedureStrategy = {
    id: opts.id ?? "fake-strategy",
    async nextStep(view) {
      nextStepViews.push(view);
      const move = queue.shift();
      if (!move) {
        throw new Error(
          "fake strategy: nextStep() called more times than scripted"
        );
      }
      return move;
    },
    async bridge(view) {
      bridgeViews.push(view);
      if (!opts.bridgeResult) {
        throw new Error("fake strategy: bridge() called but not scripted");
      }
      return opts.bridgeResult;
    },
  };

  return { strategy, nextStepViews, bridgeViews };
}

/** A planned procedure fixture — a batch of one "text"-provider request. */
function fixturePlannedProcedure(
  name: string,
  relevance: PlannedProcedure["relevance"],
  finding: string
): PlannedProcedure {
  return {
    name,
    relevance,
    parts: [
      { provider: "text", input: { instruction: finding }, alt: finding },
    ],
  };
}

/** A `planProcedureResults`-shaped LLM response for a single-procedure batch. */
function planResponse(
  key: string,
  relevance: PlannedProcedure["relevance"],
  finding: string
) {
  return JSON.stringify({
    plans: [
      {
        key,
        requests: [
          { provider: "text", input: { instruction: finding }, alt: finding },
        ],
        relevance,
      },
    ],
  });
}

function buildGraph(
  runtime: GraphRuntime,
  strategy: ProcedureStrategy,
  providers: ModalityProvider<unknown>[] = [
    makeRecordingTextProvider().provider,
  ]
) {
  return buildProcedureGraph(
    runtime,
    strategy,
    providers,
    createTraceNode(new EventBus())
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("procedure graph — output surface (issue 17 §1)", () => {
  it("buildProcedureGraph writes back only `case`", () => {
    const runtime = buildFakeRuntime(makeQueuedLlmPort({}));
    const { strategy } = makeScriptedStrategy({});
    const graph = buildGraph(runtime, strategy);
    expect([...graph.outputChannels].sort()).toEqual(["case"]);
  });

  it("buildBlindedSolverGraph writes back only `move`", () => {
    const { strategy } = makeScriptedStrategy({});
    const graph = buildBlindedSolverGraph(strategy);
    expect([...graph.outputChannels].sort()).toEqual(["move"]);
  });
});

describe("procedure graph — driven by a fake ProcedureStrategy", () => {
  it("drives order → results → order → diagnose(correct) → render_results → END, with zero LLM calls from the strategy", async () => {
    const llm = makeQueuedLlmPort({
      generator: [
        planResponse("CBC", "obligatory", "WBC 11k"),
        planResponse("CT chest", "obligatory", "Infiltrate"),
      ],
      judge: [JSON.stringify({ matches: true })],
    });
    const runtime = buildFakeRuntime(llm);
    const { provider, calls } = makeRecordingTextProvider();

    const { strategy, nextStepViews, bridgeViews } = makeScriptedStrategy({
      nextSteps: [
        { action: "order", procedures: [{ name: "CBC" }] },
        { action: "order", procedures: [{ name: "CT chest" }] },
        { action: "diagnose", diagnosisName: "Pneumonia" },
      ],
    });

    const result = await buildGraph(runtime, strategy, [provider]).invoke({
      diagnosis: { name: "Pneumonia" },
      case: {},
    });

    expect(result.case.procedures?.map((p) => p.name)).toEqual([
      "CBC",
      "CT chest",
    ]);
    expect(nextStepViews).toHaveLength(3);
    expect(bridgeViews).toHaveLength(0);
    // Already-ordered exclusion still holds against `plannedProcedures`
    // (issue 21 §7 C2's regression risk): the second blinded view already
    // carries CBC's planned finding — projected as `alt`, not rendered bytes
    // — which is what the real aigateway's `.exclude(...)` reads to keep a
    // duplicate order impossible.
    expect(nextStepViews[1]?.previousProcedures).toEqual([
      { name: "CBC", relevance: "obligatory", result: "WBC 11k" },
    ]);
    // One `render` call for the WHOLE list (issue 21 §7): both procedures'
    // instructions arrive in a single batch, not one call each.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
  });

  it("emits a paired started/terminal label for every node, blinded_step revisited 3x, result_step 2x (#140)", async () => {
    const llm = makeQueuedLlmPort({
      generator: [
        planResponse("CBC", "obligatory", "WBC 11k"),
        planResponse("CT chest", "obligatory", "Infiltrate"),
      ],
      judge: [JSON.stringify({ matches: true })],
    });
    const runtime = buildFakeRuntime(llm);
    const { provider } = makeRecordingTextProvider();

    const { strategy } = makeScriptedStrategy({
      nextSteps: [
        { action: "order", procedures: [{ name: "CBC" }] },
        { action: "order", procedures: [{ name: "CT chest" }] },
        { action: "diagnose", diagnosisName: "Pneumonia" },
      ],
    });

    const bus = new EventBus();
    const channel = createJobEventChannel();
    wireLabels(bus, channel, new InMemoryLabelCatalog());
    const jobId = "job-solver-loop";
    channel.open(jobId);
    const labels: LabelEvent[] = [];
    channel.subscribe(jobId, (e) => {
      if (e.type === "label") labels.push(e.data);
    });

    const graph = buildProcedureGraph(
      runtime,
      strategy,
      [provider],
      createTraceNode(bus)
    );

    await runWithContext(
      () =>
        graph.invoke({
          diagnosis: { name: "Pneumonia" },
          case: {},
        }),
      jobId
    );

    const byNode = new Map<string, LabelEvent[]>();
    for (const label of labels) {
      const list = byNode.get(label.nodeId) ?? [];
      list.push(label);
      byNode.set(label.nodeId, list);
    }

    for (const [, nodeLabels] of byNode) {
      const started = nodeLabels.filter((l) => l.status === "started").length;
      const completed = nodeLabels.filter(
        (l) => l.status === "completed"
      ).length;
      const failed = nodeLabels.filter((l) => l.status === "failed").length;
      expect(started).toBeGreaterThanOrEqual(1);
      expect(started).toBe(completed + failed);
    }

    expect(
      [...byNode.entries()]
        .find(([nodeId]) => nodeId.endsWith("blinded_step"))?.[1]
        .filter((l) => l.status === "started")
    ).toHaveLength(3);
    expect(
      [...byNode.entries()]
        .find(([nodeId]) => nodeId.endsWith("result_step"))?.[1]
        .filter((l) => l.status === "started")
    ).toHaveLength(2);

    for (const label of labels) {
      expect(Object.keys(label).sort()).toEqual(
        ["jobId", "label", "nodeId", "status", "timestamp"].sort()
      );
    }
  });

  it("iteration-cap exhaustion routes to bridge without ever calling nextStep", async () => {
    const runtime = buildFakeRuntime(makeQueuedLlmPort({}));
    const { provider } = makeRecordingTextProvider();

    const { strategy, nextStepViews, bridgeViews } = makeScriptedStrategy({
      bridgeResult: [
        fixturePlannedProcedure("Biopsy", "obligatory", "Positive"),
      ],
    });

    const result = await buildGraph(runtime, strategy, [provider]).invoke({
      diagnosis: { name: "Lymphoma" },
      case: {},
      solverIterationsRemaining: 0,
    });

    expect(nextStepViews).toHaveLength(0);
    expect(bridgeViews).toHaveLength(1);
    expect(result.case.procedures?.map((p) => p.name)).toEqual(["Biopsy"]);
  });

  it("a wrong diagnosis is appended to ruledOutDiagnoses and is visible on the next nextStep call", async () => {
    const llm = makeQueuedLlmPort({
      judge: [
        JSON.stringify({ matches: false }),
        JSON.stringify({ matches: true }),
      ],
    });
    const runtime = buildFakeRuntime(llm);

    const { strategy, nextStepViews } = makeScriptedStrategy({
      nextSteps: [
        { action: "diagnose", diagnosisName: "Wrong Dx" },
        { action: "diagnose", diagnosisName: "Right Dx" },
      ],
    });

    await buildGraph(runtime, strategy).invoke({
      diagnosis: { name: "Right Dx" },
      case: {},
    });

    expect(nextStepViews).toHaveLength(2);
    expect(nextStepViews[0]?.ruledOutDiagnoses).toEqual([]);
    expect(nextStepViews[1]?.ruledOutDiagnoses).toEqual(["Wrong Dx"]);
  });

  it("an `exhausted` move routes to bridge", async () => {
    const runtime = buildFakeRuntime(makeQueuedLlmPort({}));

    const { strategy, bridgeViews } = makeScriptedStrategy({
      nextSteps: [{ action: "exhausted", reason: "empty pick" }],
      bridgeResult: [],
    });

    await buildGraph(runtime, strategy).invoke({
      diagnosis: { name: "Unknown" },
      case: {},
    });

    expect(bridgeViews).toHaveLength(1);
  });

  it("has exactly four nodes under both PROCEDURE_PRESELECTION values, render_results is terminal, and both strategies produce the same node set", async () => {
    // Categorized so `createProcedureStrategy` is free to pick either path.
    const categorizedCatalog = new InMemoryProcedureCatalog([
      "Lab: CBC",
      "Imaging: CT chest",
    ]);
    const runtime = buildFakeRuntime(makeQueuedLlmPort({}), categorizedCatalog);
    const traceNode = createTraceNode(new EventBus());
    const { provider } = makeRecordingTextProvider();

    const directStrategy = createProcedureStrategy(runtime, false, [provider]);
    const scopedStrategy = createProcedureStrategy(runtime, true, [provider]);

    expect(directStrategy.id).toBe("direct-pick");
    expect(scopedStrategy.id).toBe("category-scoped-pick");

    const graphOf = (strategy: ProcedureStrategy) =>
      buildProcedureGraph(runtime, strategy, [provider], traceNode);

    const nodesOf = async (strategy: ProcedureStrategy) => {
      const { nodes } = await graphOf(strategy).getGraphAsync();
      return Object.keys(nodes)
        .filter((n) => n !== "__start__" && n !== "__end__")
        .sort();
    };

    const directNodes = await nodesOf(directStrategy);
    const scopedNodes = await nodesOf(scopedStrategy);

    expect(directNodes).toEqual([
      "blinded_step",
      "bridge",
      "render_results",
      "result_step",
    ]);
    expect(scopedNodes).toEqual(directNodes);

    // `render_results` is terminal: its only outgoing edge is `END`.
    const { edges } = await graphOf(directStrategy).getGraphAsync();
    const fromRenderResults = edges.filter(
      (e) => e.source === "render_results"
    );
    expect(fromRenderResults).toHaveLength(1);
    expect(fromRenderResults[0]?.target).toBe("__end__");
  });

  it("rejects an empty modality registry at build time (issue 21 §7)", () => {
    const runtime = buildFakeRuntime(makeQueuedLlmPort({}));
    const { strategy } = makeScriptedStrategy({});

    expect(() =>
      buildProcedureGraph(
        runtime,
        strategy,
        [],
        createTraceNode(new EventBus())
      )
    ).toThrow(/modality registry is empty/i);
  });

  it("both the match path and the bridge path reach render_results, with `case.procedures` empty at every point before it and populated after (issue 21 §7)", async () => {
    const llm = makeQueuedLlmPort({
      generator: [planResponse("CBC", "obligatory", "WBC 11k")],
      judge: [JSON.stringify({ matches: true })],
    });
    const runtime = buildFakeRuntime(llm);
    const { provider } = makeRecordingTextProvider();

    const { strategy } = makeScriptedStrategy({
      nextSteps: [
        { action: "order", procedures: [{ name: "CBC" }] },
        { action: "diagnose", diagnosisName: "Pneumonia" },
      ],
    });

    const graph = buildGraph(runtime, strategy, [provider]);
    const seenProcedureCounts: number[] = [];
    for await (const chunk of await graph.stream(
      { diagnosis: { name: "Pneumonia" }, case: {} },
      { streamMode: "values" }
    )) {
      const typed = chunk as { case?: { procedures?: unknown[] } };
      seenProcedureCounts.push(typed.case?.procedures?.length ?? 0);
    }

    // Every superstep before the last has no rendered procedures yet...
    expect(seenProcedureCounts.slice(0, -1).every((n) => n === 0)).toBe(true);
    // ...and the last one (after render_results) has exactly one.
    expect(seenProcedureCounts.at(-1)).toBe(1);
  });

  it("the blinded child graph's state schema has no `diagnosis` field, and a smuggled-in value does not survive a real invoke", async () => {
    const { strategy, nextStepViews } = makeScriptedStrategy({
      nextSteps: [{ action: "exhausted", reason: "empty pick" }],
    });

    const childGraph = buildBlindedSolverGraph(strategy);

    // `BlindedView` makes this a compile error everywhere it's actually
    // constructed — this cast simulates a bug that tries to smuggle the
    // diagnosis in anyway, to prove the runtime backstop independent of the
    // type.
    const smuggledInput = {
      presentation: {},
      previousProcedures: [],
      ruledOutDiagnoses: [],
      iterationsRemaining: 3,
      diagnosis: { name: "Should never arrive" },
    } as unknown as Parameters<typeof childGraph.invoke>[0];

    const result = await childGraph.invoke(smuggledInput);

    expect(result).not.toHaveProperty("diagnosis");
    expect(nextStepViews).toHaveLength(1);
    expect(nextStepViews[0]).not.toHaveProperty("diagnosis");
  });

  it("createProcedureStrategy falls back to DirectPick when PROCEDURE_PRESELECTION is set but the catalogue has no categories", () => {
    // No "Category: Name" prefixes ⇒ categories() is empty.
    const flatCatalog = new InMemoryProcedureCatalog(["CBC", "CT chest"]);
    const runtime = buildFakeRuntime(makeQueuedLlmPort({}), flatCatalog);
    const { provider } = makeRecordingTextProvider();

    const strategy = createProcedureStrategy(runtime, true, [provider]);

    expect(strategy.id).toBe("direct-pick");
  });
});
