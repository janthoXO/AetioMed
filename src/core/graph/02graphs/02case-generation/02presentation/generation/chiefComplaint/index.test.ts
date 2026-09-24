// Drives compiled `chiefComplaintGraph` directly (no Send, filesystem, real LLM); fake `LlmPort` throws on anything unscripted.
import { describe, expect, it } from "vitest";
import z from "zod";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { EventBus } from "@/core/event-bus.js";
import { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { buildChiefComplaintGraph } from "./index.js";
import type { GraphRuntime, LlmPort, LlmRole } from "@/core/graph/runtime.js";
import type { ModalityProvider } from "@/core/graph/modality/ports.js";
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

/** The one production-shaped provider: batch-in, batch-out, `{instruction}` input. */
function textProvider(id = "text"): ModalityProvider<unknown> {
  return {
    id,
    mime: "text/plain",
    description: "test text provider",
    inputSchema: z.object({ instruction: z.string().min(1) }),
    render: async (batch) =>
      (batch as { instruction: string }[]).map((b) =>
        new TextEncoder().encode(b.instruction)
      ),
  };
}

/** A non-text provider, for the multi-provider registry tests. */
function imageProvider(): ModalityProvider<unknown> {
  return {
    id: "image",
    mime: "image/png",
    description: "test image provider",
    inputSchema: z.object({ prompt: z.string().min(1) }),
    render: async (batch) =>
      (batch as { prompt: string }[]).map((b) =>
        new TextEncoder().encode(`img:${b.prompt}`)
      ),
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
  providers: ModalityProvider<unknown>[],
  bus: EventBus = new EventBus()
) {
  const runtime = buildFakeRuntime(llm);
  return buildChiefComplaintGraph(runtime, providers, createTraceNode(bus));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("chiefComplaintGraph — output surface", () => {
  it("writes back only `case`, not the whole state schema, at either registry size", () => {
    const single = buildGraph(makeQueuedLlmPort({}), [textProvider()]);
    const multi = buildGraph(makeQueuedLlmPort({}), [
      textProvider(),
      imageProvider(),
    ]);

    expect([...single.outputChannels].sort()).toEqual(["case"]);
    expect([...multi.outputChannels].sort()).toEqual(["case"]);
  });
});

describe("chiefComplaintGraph — node shape (no registry-size branching)", () => {
  it("rejects an empty registry immediately, at build time", () => {
    expect(() => buildGraph(makeQueuedLlmPort({}), [])).toThrow(
      EmptyModalityRegistryError
    );
  });

  it("compiles exactly plan_content and render_parts with a one-provider registry", async () => {
    const graph = buildGraph(makeQueuedLlmPort({}), [textProvider()]);
    const ids = await nodeIds(graph);
    expect(ids).toEqual(
      ["__start__", "__end__", "plan_content", "render_parts"].sort()
    );
  });

  it("compiles exactly plan_content and render_parts with a two-provider registry too", async () => {
    const graph = buildGraph(makeQueuedLlmPort({}), [
      textProvider(),
      imageProvider(),
    ]);
    const ids = await nodeIds(graph);
    expect(ids).toEqual(
      ["__start__", "__end__", "plan_content", "render_parts"].sort()
    );
  });
});

describe("chiefComplaintGraph — single-provider registry", () => {
  it("plans then renders one text/plain part, with exactly one planning call and one render call", async () => {
    const llm = makeQueuedLlmPort({
      generator: [
        // plan_content
        JSON.stringify({
          plans: [
            {
              key: "chiefComplaint",
              requests: [
                {
                  provider: "text",
                  input: { instruction: "Acute dyspnea." },
                  alt: "Acute dyspnea.",
                },
              ],
            },
          ],
        }),
        // render_parts (the text provider's own LLM call, scripted directly
        // since this test's fake provider does not itself call the LLM —
        // see the batching test below for that path exercised for real).
      ],
    });
    const bus = new EventBus();
    const started: string[] = [];
    bus.on("Node Started", (e) => started.push(e.node));
    const graph = buildGraph(llm, [textProvider()], bus);

    const result = (await graph.invoke({
      diagnosis,
      outline: "outline text",
      userInstructions: undefined,
      case: {},
    })) as { case: Case };

    const parts = result.case.chiefComplaint!;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe("text/plain");
    expect(parts[0]!.alt).toBe("Acute dyspnea.");
    expect(new TextDecoder().decode(parts[0]!.value)).toBe("Acute dyspnea.");

    expect(started).toEqual(
      expect.arrayContaining(["plan_content", "render_parts"])
    );
  });

  it("carries the planner's alt through even when the provider renders different prose (alt !== rendered text is legal)", async () => {
    const llm = makeQueuedLlmPort({
      generator: [
        JSON.stringify({
          plans: [
            {
              key: "chiefComplaint",
              requests: [
                {
                  provider: "text",
                  input: { instruction: "irrelevant to this fake provider" },
                  alt: "Broken right leg.",
                },
              ],
            },
          ],
        }),
      ],
    });
    const fakeProvider: ModalityProvider<unknown> = {
      id: "text",
      mime: "application/x-fake",
      description: "renders something unrelated to alt",
      inputSchema: z.unknown(),
      render: async () => [new TextEncoder().encode("FAKE RENDERED TEXT")],
    };

    const graph = buildGraph(llm, [fakeProvider]);
    const result = (await graph.invoke({
      diagnosis,
      outline: "outline text",
      case: {},
    })) as { case: Case };

    const parts = result.case.chiefComplaint!;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe("application/x-fake");
    expect(parts[0]!.alt).toBe("Broken right leg.");
    expect(new TextDecoder().decode(parts[0]!.value)).toBe(
      "FAKE RENDERED TEXT"
    );
  });
});

describe("chiefComplaintGraph — multi-provider registry: planned order, not completion order", () => {
  it("orders parts by the planned order, not completion order — the first-planned request resolves last", async () => {
    const slow: ModalityProvider<unknown> = {
      id: "slow",
      mime: "application/x-slow",
      description: "slow",
      inputSchema: z.unknown(),
      render: async (batch) => {
        await new Promise((r) => setTimeout(r, 30));
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
              key: "chiefComplaint",
              requests: [
                { provider: "slow", input: "slow input", alt: "slow alt" },
                { provider: "fast", input: "fast input", alt: "fast alt" },
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
    expect(new TextDecoder().decode(parts[0]!.value)).toBe("slow:slow input");
    expect(new TextDecoder().decode(parts[1]!.value)).toBe("fast:fast input");
    for (const part of parts) {
      expect(part.alt.length).toBeGreaterThan(0);
    }
  });
});
