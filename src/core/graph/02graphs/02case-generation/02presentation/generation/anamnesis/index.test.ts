// Same style as `chiefComplaint/index.test.ts`: drives the compiled
// `anamnesisGraph` directly, with a fake `LlmPort` that throws on anything
// unscripted. The anamnesis-specific behaviour under test is per-category
// planning and reassembly in CATALOGUE order (issue 13 §2, issue 21 §7),
// not LLM array order, plus the cross-category BATCHING property the
// planner architecture exists for (issue 21 §3/§6).
import { describe, expect, it } from "vitest";
import z from "zod";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { EventBus } from "@/core/event-bus.js";
import { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { buildAnamnesisGraph } from "./index.js";
import type { GraphRuntime, LlmPort, LlmRole } from "@/core/graph/runtime.js";
import type { ModalityProvider } from "@/core/graph/modality/ports.js";
import { EmptyModalityRegistryError } from "@/core/graph/modality/registry.js";
import { InMemoryAnamnesisCatalog } from "@/core/graph/catalog/anamnesis/index.js";
import { InMemoryProcedureCatalog } from "@/core/graph/catalog/procedures/index.js";
import { InMemoryLabelCatalog } from "@/core/graph/catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "@/core/graph/catalog/diagnosis/index.js";
import type { Diagnosis } from "@/core/graph/models/Diagnosis.js";
import type { Case } from "@/core/graph/models/Case.js";

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
  categories: string[] = ["Current Symptoms", "Past Illnesses"]
): GraphRuntime {
  return {
    llm,
    catalogs: {
      procedures: new InMemoryProcedureCatalog(),
      anamnesis: new InMemoryAnamnesisCatalog(categories),
      labels: new InMemoryLabelCatalog(),
      diagnosis: new InMemoryDiagnosisCatalog(),
    },
    log: { info() {}, warn() {}, error() {} },
    clock: () => new Date("2024-01-01T00:00:00.000Z"),
  };
}

/** Counts calls and echoes each instruction back as its own rendered text. */
function makeCountingTextProvider(): {
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
      return typed.map((b) => new TextEncoder().encode(b.instruction));
    },
  };
  return { provider, calls };
}

const diagnosis: Diagnosis = { name: "Influenza", icd: "1E32" };

function buildGraph(
  llm: LlmPort,
  providers: ModalityProvider<unknown>[],
  categories?: string[],
  bus: EventBus = new EventBus()
) {
  const runtime = buildFakeRuntime(llm, categories);
  return buildAnamnesisGraph(runtime, providers, createTraceNode(bus));
}

describe("anamnesisGraph — output surface (issue 17 §1)", () => {
  it("writes back only `case`, not the whole state schema", () => {
    const { provider } = makeCountingTextProvider();
    const graph = buildGraph(makeQueuedLlmPort({}), [provider]);
    expect([...graph.outputChannels].sort()).toEqual(["case"]);
  });
});

describe("anamnesisGraph — node shape (issue 21 §7: no registry-size branching)", () => {
  it("rejects an empty registry immediately, at build time", () => {
    expect(() => buildGraph(makeQueuedLlmPort({}), [])).toThrow(
      EmptyModalityRegistryError
    );
  });

  it("compiles exactly plan_content and render_parts", async () => {
    const { provider } = makeCountingTextProvider();
    const graph = buildGraph(makeQueuedLlmPort({}), [provider]);
    const drawn = await graph.getGraphAsync({ xray: true });
    expect(Object.keys(drawn.nodes).sort()).toEqual(
      ["__start__", "__end__", "plan_content", "render_parts"].sort()
    );
  });
});

describe("anamnesisGraph", () => {
  it("reorders categories to CATALOGUE order, not the planner's array order (issue 13 §2)", async () => {
    const { provider } = makeCountingTextProvider();
    const llm = makeQueuedLlmPort({
      generator: [
        // The planner returns "Past Illnesses" before "Current Symptoms" —
        // the catalogue says the opposite.
        JSON.stringify({
          plans: [
            {
              key: "Past Illnesses",
              requests: [
                {
                  provider: "text",
                  input: { instruction: "None." },
                  alt: "None.",
                },
              ],
            },
            {
              key: "Current Symptoms",
              requests: [
                {
                  provider: "text",
                  input: { instruction: "Fever." },
                  alt: "Fever.",
                },
              ],
            },
          ],
        }),
      ],
    });

    const graph = buildGraph(
      llm,
      [provider],
      ["Current Symptoms", "Past Illnesses"]
    );

    const result = (await graph.invoke({
      diagnosis,
      outline: "outline text",
      case: {},
    })) as { case: Case };

    const anamnesis = result.case.anamnesis!;
    expect(anamnesis.map((f) => f.category)).toEqual([
      "Current Symptoms",
      "Past Illnesses",
    ]);
    expect(new TextDecoder().decode(anamnesis[0]!.answer[0]!.value)).toBe(
      "Fever."
    );
    expect(new TextDecoder().decode(anamnesis[1]!.answer[0]!.value)).toBe(
      "None."
    );
  });

  it("batches every category's instructions into ONE render call (issue 21 §6) — the token-efficiency property this design exists for", async () => {
    const { provider, calls } = makeCountingTextProvider();
    const llm = makeQueuedLlmPort({
      generator: [
        JSON.stringify({
          plans: [
            {
              key: "Current Symptoms",
              requests: [
                {
                  provider: "text",
                  input: { instruction: "Fever." },
                  alt: "Fever.",
                },
              ],
            },
            {
              key: "Past Illnesses",
              requests: [
                {
                  provider: "text",
                  input: { instruction: "None." },
                  alt: "None.",
                },
              ],
            },
          ],
        }),
      ],
    });

    const graph = buildGraph(
      llm,
      [provider],
      ["Current Symptoms", "Past Illnesses"]
    );

    await graph.invoke({
      diagnosis,
      outline: "outline text",
      case: {},
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      { instruction: "Fever." },
      { instruction: "None." },
    ]);
  });

  it("gives every category's answer a non-empty alt under a two-provider registry, fan-in per category following planned order", async () => {
    const slow: ModalityProvider<unknown> = {
      id: "slow",
      mime: "application/x-slow",
      description: "slow",
      inputSchema: z.unknown(),
      render: async (batch) => {
        await new Promise((r) => setTimeout(r, 20));
        return (batch as string[]).map((v) =>
          new TextEncoder().encode(`slow:${v}`)
        );
      },
    };
    const fast: ModalityProvider<unknown> = {
      id: "fast",
      mime: "application/x-fast",
      description: "fast",
      inputSchema: z.unknown(),
      render: async (batch) =>
        (batch as string[]).map((v) => new TextEncoder().encode(`fast:${v}`)),
    };

    const llm = makeQueuedLlmPort({
      generator: [
        JSON.stringify({
          plans: [
            {
              key: "Current Symptoms",
              requests: [
                { provider: "slow", input: "slow desc", alt: "slow desc" },
                { provider: "fast", input: "fast desc", alt: "fast desc" },
              ],
            },
          ],
        }),
      ],
    });

    const graph = buildGraph(llm, [slow, fast], ["Current Symptoms"]);
    const result = (await graph.invoke({
      diagnosis,
      outline: "outline text",
      case: {},
    })) as { case: Case };

    const answer = result.case.anamnesis![0]!.answer;
    expect(answer.map((p) => p.type)).toEqual([
      "application/x-slow",
      "application/x-fast",
    ]);
    for (const part of answer) {
      expect(part.alt.length).toBeGreaterThan(0);
    }
  });
});
