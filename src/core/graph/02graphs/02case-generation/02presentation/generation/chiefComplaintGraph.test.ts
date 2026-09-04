// Drives the compiled `chiefComplaintGraph` directly (no outer Send/fan-in,
// no filesystem, no real LLM) — mirrors the house style in
// `03procedure/index.test.ts`: a fake `LlmPort` that throws the moment
// something calls it that a test did not script, which is what proves the
// text provider makes no LLM call at all (issue 13 §3/§7).
import { describe, expect, it } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { EventBus } from "@/core/event-bus.js";
import { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { buildChiefComplaintGraph } from "./chiefComplaintGraph.js";
import type { GraphRuntime, LlmPort, LlmRole } from "@/core/graph/runtime.js";
import type { ModalityProvider } from "@/core/graph/modality/ports.js";
import { createTextModalityProvider } from "@/core/graph/modality/providers/text.js";
import { EmptyModalityRegistryError } from "@/core/graph/modality/registry.js";
import { InMemoryProcedureCatalog } from "@/core/graph/catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "@/core/graph/catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "@/core/graph/catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "@/core/graph/catalog/diagnosis/index.js";
import type { Diagnosis } from "@/core/graph/models/Diagnosis.js";
import type { Case } from "@/core/graph/models/Case.js";

// ─── Fakes ──────────────────────────────────────────────────────────────────

/** A `LlmPort` serving a scripted, per-role queue — throws on anything unscripted. */
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

function buildFakeRuntime(llm: LlmPort): GraphRuntime {
  return {
    llm,
    catalogs: {
      procedures: new InMemoryProcedureCatalog(),
      anamnesis: new InMemoryAnamnesisCatalog(),
      labels: new InMemoryLabelCatalog(),
      diagnosis: new InMemoryDiagnosisCatalog(),
    },
    log: { info() {}, warn() {}, error() {} },
    clock: () => new Date("2024-01-01T00:00:00.000Z"),
  };
}

/** A provider that resolves after `delayMs`, tagging its output so tests can tell order apart. */
function makeStaggeredProvider(opts: {
  id: string;
  mime: string;
  delayMs: number;
}): ModalityProvider {
  return {
    id: opts.id,
    produces: [opts.mime],
    async render(alt) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
      return new TextEncoder().encode(`${opts.id}:${alt}`);
    },
  };
}

const diagnosis: Diagnosis = { name: "Influenza", icd: "1E32" };

async function nodeIds(graph: {
  getGraphAsync: (opts: { xray: boolean }) => Promise<{
    nodes: Record<string, unknown>;
  }>;
}): Promise<string[]> {
  const drawn = await graph.getGraphAsync({ xray: true });
  return Object.keys(drawn.nodes).sort();
}

function buildGraph(
  llm: LlmPort,
  registry: ModalityProvider[],
  bus: EventBus = new EventBus()
) {
  const runtime = buildFakeRuntime(llm);
  return buildChiefComplaintGraph(runtime, registry, createTraceNode(bus));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("chiefComplaintGraph — node shape by registry size (issue 13 §4/§7)", () => {
  it("rejects an empty registry immediately, at build time", () => {
    expect(() => buildGraph(makeQueuedLlmPort({}), [])).toThrow(
      EmptyModalityRegistryError
    );
  });

  it("compiles no decide_modality node with a single-entry registry", async () => {
    const graph = buildGraph(makeQueuedLlmPort({}), [
      createTextModalityProvider(),
    ]);
    const ids = await nodeIds(graph);
    expect(ids).not.toContain("decide_modality");
    expect(ids).toContain("generate_content");
    expect(ids).toContain("render_parts");
  });

  it("compiles a decide_modality node with a two-entry registry", async () => {
    const graph = buildGraph(makeQueuedLlmPort({}), [
      createTextModalityProvider(),
      makeStaggeredProvider({ id: "img", mime: "image/png", delayMs: 0 }),
    ]);
    const ids = await nodeIds(graph);
    expect(ids).toContain("decide_modality");
  });
});

describe("chiefComplaintGraph — single-entry (text-only) registry", () => {
  it("produces one text/plain part from the existing gateway call, with zero extra LLM calls", async () => {
    const llm = makeQueuedLlmPort({
      generator: [JSON.stringify({ chiefComplaint: "Acute dyspnea." })],
    });
    const bus = new EventBus();
    const started: string[] = [];
    bus.on("Node Started", (e) => started.push(e.node));
    const graph = buildGraph(llm, [createTextModalityProvider()], bus);

    const result = (await graph.invoke({
      diagnosis,
      outline: "outline text",
      userInstructions: undefined,
      case: {},
    })) as { case: Case };

    const parts = result.case.chiefComplaint!;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("text/plain");
    expect(parts[0].alt).toBe("Acute dyspnea.");
    expect(new TextDecoder().decode(parts[0].value)).toBe("Acute dyspnea.");

    // Trace events fired per node (issue 13 §7) — and only two nodes exist
    // at this registry size.
    expect(started).toEqual(
      expect.arrayContaining(["generate_content", "render_parts"])
    );
    expect(started).not.toContain("decide_modality");
  });

  it("works end to end with a fake non-LLM provider (issue 13 §7)", async () => {
    const llm = makeQueuedLlmPort({
      generator: [JSON.stringify({ chiefComplaint: "Some complaint." })],
    });
    const fakeProvider: ModalityProvider = {
      id: "fake",
      produces: ["application/x-fake"],
      render: async (alt) => new TextEncoder().encode(`FAKE:${alt}`),
    };

    const graph = buildGraph(llm, [fakeProvider]);
    const result = (await graph.invoke({
      diagnosis,
      outline: "outline text",
      case: {},
    })) as { case: Case };

    const parts = result.case.chiefComplaint!;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("application/x-fake");
    expect(parts[0].alt).toBe("Some complaint.");
    expect(new TextDecoder().decode(parts[0].value)).toBe(
      "FAKE:Some complaint."
    );
  });

  it("an image-only (non-text) single-entry registry still yields a non-empty alt", async () => {
    const llm = makeQueuedLlmPort({
      generator: [JSON.stringify({ chiefComplaint: "Broken right leg." })],
    });
    const imageProvider = makeStaggeredProvider({
      id: "img",
      mime: "image/png",
      delayMs: 0,
    });

    const graph = buildGraph(llm, [imageProvider]);
    const result = (await graph.invoke({
      diagnosis,
      outline: "outline text",
      case: {},
    })) as { case: Case };

    const parts = result.case.chiefComplaint!;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("image/png");
    expect(parts[0].alt.length).toBeGreaterThan(0);
    expect(parts[0].alt).toBe("Broken right leg.");
  });
});

describe("chiefComplaintGraph — multi-entry registry: decide_modality plans, fan-in follows PLANNED order", () => {
  it("orders parts by the planned order, not completion order — the first-planned request resolves last", async () => {
    const slow = makeStaggeredProvider({
      id: "slow",
      mime: "application/x-slow",
      delayMs: 30,
    });
    const fast = makeStaggeredProvider({
      id: "fast",
      mime: "application/x-fast",
      delayMs: 0,
    });

    const llm = makeQueuedLlmPort({
      generator: [
        // generate_content
        JSON.stringify({ chiefComplaint: "Chest pain." }),
        // decide_modality: slow-mime planned FIRST, fast-mime SECOND —
        // if fan-in followed completion order, fast would land first.
        JSON.stringify({
          plans: [
            {
              key: "chiefComplaint",
              requests: [
                { modality: "application/x-slow", alt: "slow alt" },
                { modality: "application/x-fast", alt: "fast alt" },
              ],
            },
          ],
        }),
      ],
    });

    const graph = buildGraph(llm, [slow, fast]);
    const result = (await graph.invoke({
      diagnosis,
      outline: "outline text",
      case: {},
    })) as { case: Case };

    const parts = result.case.chiefComplaint!;
    expect(parts.map((p) => p.type)).toEqual([
      "application/x-slow",
      "application/x-fast",
    ]);
    expect(new TextDecoder().decode(parts[0].value)).toBe("slow:slow alt");
    expect(new TextDecoder().decode(parts[1].value)).toBe("fast:fast alt");
    // Every part carries a non-empty `alt`, regardless of modality.
    for (const part of parts) {
      expect(part.alt.length).toBeGreaterThan(0);
    }
  });
});
