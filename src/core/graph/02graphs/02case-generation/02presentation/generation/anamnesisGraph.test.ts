// Same style as `chiefComplaintGraph.test.ts`: drives the compiled
// `anamnesisGraph` directly, with a fake `LlmPort` that throws on anything
// unscripted. The anamnesis-specific behaviour under test is per-category
// planning/rendering and reassembly in CATALOGUE order (issue 13 §2/§7),
// not LLM array order.
import { describe, expect, it } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { EventBus } from "@/core/event-bus.js";
import { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { buildAnamnesisGraph } from "./anamnesisGraph.js";
import type { GraphRuntime, LlmPort, LlmRole } from "@/core/graph/runtime.js";
import type { ModalityProvider } from "@/core/graph/modality/ports.js";
import { createTextModalityProvider } from "@/core/graph/modality/providers/text.js";
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

const diagnosis: Diagnosis = { name: "Influenza", icd: "1E32" };

function buildGraph(
  llm: LlmPort,
  registry: ModalityProvider[],
  categories?: string[],
  bus: EventBus = new EventBus()
) {
  const runtime = buildFakeRuntime(llm, categories);
  return buildAnamnesisGraph(runtime, registry, createTraceNode(bus));
}

describe("anamnesisGraph", () => {
  it("rejects an empty registry immediately, at build time", () => {
    expect(() => buildGraph(makeQueuedLlmPort({}), [])).toThrow(
      EmptyModalityRegistryError
    );
  });

  it("reorders categories to CATALOGUE order, not the LLM's array order (issue 13 §2)", async () => {
    const llm = makeQueuedLlmPort({
      generator: [
        // The LLM returns "Past Illnesses" before "Current Symptoms" —
        // the catalogue says the opposite.
        JSON.stringify({
          anamnesis: [
            { category: "Past Illnesses", answer: "None." },
            { category: "Current Symptoms", answer: "Fever." },
          ],
        }),
      ],
    });

    const graph = buildGraph(
      llm,
      [createTextModalityProvider()],
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
    expect(new TextDecoder().decode(anamnesis[0].answer[0].value)).toBe(
      "Fever."
    );
    expect(new TextDecoder().decode(anamnesis[1].answer[0].value)).toBe(
      "None."
    );
  });

  it("gives every category's answer a non-empty alt under a two-entry registry, fan-in per category following planned order", async () => {
    const slow: ModalityProvider = {
      id: "slow",
      produces: ["application/x-slow"],
      async render(alt) {
        await new Promise((r) => setTimeout(r, 20));
        return new TextEncoder().encode(`slow:${alt}`);
      },
    };
    const fast: ModalityProvider = {
      id: "fast",
      produces: ["application/x-fast"],
      render: async (alt) => new TextEncoder().encode(`fast:${alt}`),
    };

    const llm = makeQueuedLlmPort({
      generator: [
        JSON.stringify({
          anamnesis: [{ category: "Current Symptoms", answer: "Fever." }],
        }),
        JSON.stringify({
          plans: [
            {
              key: "Current Symptoms",
              requests: [
                { modality: "application/x-slow", alt: "slow desc" },
                { modality: "application/x-fast", alt: "fast desc" },
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

    const answer = result.case.anamnesis![0].answer;
    expect(answer.map((p) => p.type)).toEqual([
      "application/x-slow",
      "application/x-fast",
    ]);
    for (const part of answer) {
      expect(part.alt.length).toBeGreaterThan(0);
    }
  });
});
