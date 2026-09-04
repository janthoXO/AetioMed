// Drives the compiled procedure graph with a fake `ProcedureStrategy` and a
// fake `LlmPort` that throws if called for anything a test did not script.
// The fake strategy is the payoff of issue 07's `ProcedureStrategy` port: it
// makes it cheap to exercise the blinded solver's control flow (order →
// results → diagnose, the iteration cap, a ruled-out diagnosis, and the
// `exhausted` move) with zero LLM calls attributable to the strategy itself.
// No filesystem, no SQLite, no real LLM — mirrors the house style in
// `runtime.test.ts` and `catalog/procedures/catalog.test.ts`.
import { describe, expect, it } from "vitest";
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
import type { ProcedureResult } from "@/core/graph/models/Procedure.js";
import { InMemoryProcedureCatalog } from "@/core/graph/catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "@/core/graph/catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "@/core/graph/catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "@/core/graph/catalog/diagnosis/index.js";
import { EventBus } from "@/core/event-bus.js";
import { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { ConfigSchema } from "@/core/graph/config.js";

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

/** A scripted `ProcedureStrategy`: one move per `nextStep` call, in order. */
function makeScriptedStrategy(opts: {
  id?: string;
  nextSteps?: SolverMove[];
  bridgeResult?: ProcedureResult[];
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

function buildGraph(runtime: GraphRuntime, strategy: ProcedureStrategy) {
  return buildProcedureGraph(
    runtime,
    strategy,
    createTraceNode(new EventBus())
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("procedure graph — driven by a fake ProcedureStrategy", () => {
  it("drives order → results → order → diagnose(correct) → END, with zero LLM calls from the strategy", async () => {
    const llm = makeQueuedLlmPort({
      generator: [
        JSON.stringify({
          procedures: [
            { name: "CBC", relevance: "obligatory", result: "WBC 11k" },
          ],
        }),
        JSON.stringify({
          procedures: [
            {
              name: "CT chest",
              relevance: "obligatory",
              result: "Infiltrate",
            },
          ],
        }),
      ],
      judge: [JSON.stringify({ matches: true })],
    });
    const runtime = buildFakeRuntime(llm);

    const { strategy, nextStepViews, bridgeViews } = makeScriptedStrategy({
      nextSteps: [
        { action: "order", procedures: [{ name: "CBC" }] },
        { action: "order", procedures: [{ name: "CT chest" }] },
        { action: "diagnose", diagnosisName: "Pneumonia" },
      ],
    });

    const result = await buildGraph(runtime, strategy).invoke({
      diagnosis: { name: "Pneumonia" },
      case: {},
    });

    expect(result.case.procedures?.map((p: ProcedureResult) => p.name)).toEqual(
      ["CBC", "CT chest"]
    );
    expect(nextStepViews).toHaveLength(3);
    expect(bridgeViews).toHaveLength(0);
  });

  it("iteration-cap exhaustion routes to bridge without ever calling nextStep", async () => {
    const runtime = buildFakeRuntime(makeQueuedLlmPort({}));

    const { strategy, nextStepViews, bridgeViews } = makeScriptedStrategy({
      bridgeResult: [
        { name: "Biopsy", relevance: "obligatory", result: "Positive" },
      ],
    });

    const result = await buildGraph(runtime, strategy).invoke({
      diagnosis: { name: "Lymphoma" },
      case: {},
      solverIterationsRemaining: 0,
    });

    expect(nextStepViews).toHaveLength(0);
    expect(bridgeViews).toHaveLength(1);
    expect(result.case.procedures?.map((p: ProcedureResult) => p.name)).toEqual(
      ["Biopsy"]
    );
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

  it("has exactly three nodes under both PROCEDURE_PRESELECTION values, and both strategies produce the same node set", async () => {
    // Categorized so `createProcedureStrategy` is free to pick either path.
    const categorizedCatalog = new InMemoryProcedureCatalog([
      "Lab: CBC",
      "Imaging: CT chest",
    ]);
    const runtime = buildFakeRuntime(makeQueuedLlmPort({}), categorizedCatalog);
    const traceNode = createTraceNode(new EventBus());
    const baseConfig = ConfigSchema.parse({
      LLM_PROVIDER: "ollama",
      LLM_MODEL: "test-model",
    });

    const directStrategy = createProcedureStrategy(runtime, {
      ...baseConfig,
      PROCEDURE_PRESELECTION: false,
    });
    const scopedStrategy = createProcedureStrategy(runtime, {
      ...baseConfig,
      PROCEDURE_PRESELECTION: true,
    });

    expect(directStrategy.id).toBe("direct-pick");
    expect(scopedStrategy.id).toBe("category-scoped-pick");

    const nodesOf = async (strategy: ProcedureStrategy) => {
      const graph = buildProcedureGraph(runtime, strategy, traceNode);
      const { nodes } = await graph.getGraphAsync();
      return Object.keys(nodes)
        .filter((n) => n !== "__start__" && n !== "__end__")
        .sort();
    };

    const directNodes = await nodesOf(directStrategy);
    const scopedNodes = await nodesOf(scopedStrategy);

    expect(directNodes).toEqual(["blinded_step", "bridge", "result_step"]);
    expect(scopedNodes).toEqual(directNodes);
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
    const config = ConfigSchema.parse({
      LLM_PROVIDER: "ollama",
      LLM_MODEL: "test-model",
      PROCEDURE_PRESELECTION: "true",
    });

    const strategy = createProcedureStrategy(runtime, config);

    expect(strategy.id).toBe("direct-pick");
  });
});
