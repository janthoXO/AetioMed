// Regression test for issue 17's reported crash: a default request
// (`generationFlags` including both `chiefComplaint` and `anamnesis`) fanned
// `chief_complaint_generate` and `anamnesis_generate` out in parallel via
// `Send`. Both are compiled subgraphs, and a compiled subgraph writes back
// its ENTIRE state schema unless it declares an explicit `output` — so
// without one, the parent's `diagnosis`, `userInstructions` and `outline`
// channels each received two values in the same superstep. All three are
// `LastValue`, which accepts exactly one, so LangGraph threw
// `INVALID_CONCURRENT_GRAPH_UPDATE` (`InvalidUpdateError`). This builds a
// small parent graph mirroring `buildFieldGenerationSends`'s exact Send
// payload and mounts the REAL `buildChiefComplaintGraph`/
// `buildAnamnesisGraph` — not fakes — so a fix that merely stops the throw
// by dropping a write (rather than keeping both subgraphs' `case` output)
// cannot pass this test.
import { describe, expect, it } from "vitest";
import z from "zod";
import { END, Send, START, StateGraph } from "@langchain/langgraph";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { EventBus } from "@/core/event-bus.js";
import { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { RequestContextSchema } from "@/core/graph/utils/context.js";
import { buildChiefComplaintGraph } from "./chiefComplaint/index.js";
import { buildAnamnesisGraph } from "./anamnesis/index.js";
import { caseFanIn } from "./index.js";
import { CaseGenerationStateSchema } from "../../state.js";
import type { ModalityProvider } from "@/core/graph/modality/ports.js";
import { InMemoryProcedureCatalog } from "@/core/graph/catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "@/core/graph/catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "@/core/graph/catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "@/core/graph/catalog/diagnosis/index.js";
import type { GraphRuntime, LlmPort, LlmRole } from "@/core/graph/runtime.js";
import type { Case } from "@/core/graph/models/Case.js";

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
      anamnesis: new InMemoryAnamnesisCatalog(["History"]),
      labels: new InMemoryLabelCatalog(),
      diagnosis: new InMemoryDiagnosisCatalog(),
    },
    log: { info() {}, warn() {}, error() {} },
    clock: () => new Date("2024-01-01T00:00:00.000Z"),
  };
}

/** The one production-shaped provider: batch-in, batch-out, `{instruction}` input. */
function textProvider(): ModalityProvider<unknown> {
  return {
    id: "text",
    mime: "text/plain",
    description: "test text provider",
    inputSchema: z.object({ instruction: z.string().min(1) }),
    render: async (batch) =>
      (batch as { instruction: string }[]).map((b) =>
        new TextEncoder().encode(b.instruction)
      ),
  };
}

describe("chief_complaint_generate + anamnesis_generate fanned out together (issue 17 §0)", () => {
  it("resolves and yields both chiefComplaint and anamnesis, instead of throwing INVALID_CONCURRENT_GRAPH_UPDATE", async () => {
    const llm = makeQueuedLlmPort({
      generator: [
        // chief_complaint_generate's plan_content
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
        // anamnesis_generate's plan_content
        JSON.stringify({
          plans: [
            {
              key: "History",
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
    const runtime = buildFakeRuntime(llm);
    const bus = new EventBus();
    const traceNode = createTraceNode(bus);
    const registry = [textProvider()];

    // Mirrors `buildFieldGenerationSends`'s exact payload shape.
    const parent = new StateGraph(CaseGenerationStateSchema, {
      context: RequestContextSchema,
    })
      .addNode(
        "chief_complaint_generate",
        buildChiefComplaintGraph(
          runtime,
          registry,
          traceNode.scope("chief_complaint_generate")
        )
      )
      .addNode(
        "anamnesis_generate",
        buildAnamnesisGraph(
          runtime,
          registry,
          traceNode.scope("anamnesis_generate")
        )
      )
      .addConditionalEdges(START, (state) => [
        new Send("chief_complaint_generate", {
          diagnosis: state.diagnosis,
          outline: state.outline,
          userInstructions: state.userInstructions,
        }),
        new Send("anamnesis_generate", {
          diagnosis: state.diagnosis,
          outline: state.outline,
          userInstructions: state.userInstructions,
        }),
      ])
      .addEdge("chief_complaint_generate", END)
      .addEdge("anamnesis_generate", END)
      .compile();

    const result = (await parent.invoke({
      diagnosis: { name: "Influenza", icd: "1E32" },
      generationFlags: ["chiefComplaint", "anamnesis"],
      outline: "outline text",
      case: {},
    })) as { case: Case };

    expect(result.case.chiefComplaint).toBeDefined();
    expect(result.case.chiefComplaint![0]!.alt).toBe("Acute dyspnea.");
    expect(result.case.anamnesis).toBeDefined();
    expect(result.case.anamnesis![0]!.category).toBe("History");
  });
});

describe("case_fan_in (issue 17 §2a)", () => {
  it("writes nothing — a join point produces no update", () => {
    // It used to be `passthrough`, echoing the entire incoming state as its
    // update (a write to every channel); now it is a plain join with
    // nothing left to contribute, since `patient_generate`/
    // `chief_complaint_generate`/`anamnesis_generate` have already written
    // `case` themselves.
    expect(caseFanIn()).toEqual({});
  });
});
