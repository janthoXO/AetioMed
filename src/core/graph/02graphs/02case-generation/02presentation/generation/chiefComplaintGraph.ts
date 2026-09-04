import { END, START, StateGraph, type Runtime } from "@langchain/langgraph";
import z from "zod";
import { CaseGenerationStateSchema } from "../../state.js";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/core/graph/utils/context.js";
import { renderUserInstructions } from "@/core/graph/utils/prompt.js";
import { generationTools } from "../../tools.js";
import { textOf } from "@/core/graph/models/ContentPart.js";
import {
  ModalityRenderRequestSchema,
  type ModalityProvider,
} from "@/core/graph/modality/ports.js";
import {
  defaultPlanFor,
  renderRequests,
  type ContentUnit,
} from "@/core/graph/modality/pipeline.js";
import {
  EmptyModalityRegistryError,
  producibleModalities,
} from "@/core/graph/modality/registry.js";
import { decideModalityComposition } from "@/core/graph/03aigateway/modalityDecision.aigateway.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";

// The one content unit a chief complaint has — `key` only matters for
// anamnesis, where there is one per category (see `anamnesisGraph.ts`), but
// keeping the same `ContentUnit` shape here is what lets both fields share
// `modality/pipeline.ts`'s `defaultPlanFor`/`renderRequests` unchanged.
const CHIEF_COMPLAINT_UNIT_KEY = "chiefComplaint";

const ChiefComplaintGraphStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  case: true,
}).extend({
  outline: z.string(),
  contentUnits: z
    .array(z.object({ key: z.string(), text: z.string() }))
    .default([]),
  modalityPlan: z
    .record(z.string(), z.array(ModalityRenderRequestSchema))
    .default({}),
});

type ChiefComplaintGraphState = z.infer<typeof ChiefComplaintGraphStateSchema>;

function makeGenerateContent(runtime: GraphRuntime) {
  return async function generateContent(
    state: Pick<
      ChiefComplaintGraphState,
      "diagnosis" | "outline" | "userInstructions"
    >,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<ChiefComplaintGraphState, "contentUnits">> {
    // Reuses the existing gateway call and its z.string()-based schema
    // unchanged (issue 13 §0/§2) — this is exactly what the old single-node
    // `chief_complaint_generate` did. `textOf()` (issue 11) reads the
    // canonical text back out of the single text part the gateway wraps it
    // in, so no prompt or schema here is new.
    const chiefComplaint =
      await generationTools.generateChiefComplaintFromOutline.invoke(
        {
          diagnosis: state.diagnosis,
          outline: state.outline,
          userInstructions: renderUserInstructions(state.userInstructions),
        },
        runtime,
        lgRuntime?.context
      );

    return {
      contentUnits: [
        { key: CHIEF_COMPLAINT_UNIT_KEY, text: textOf(chiefComplaint) },
      ],
    };
  };
}

function makeDecideModality(
  runtime: GraphRuntime,
  registry: ModalityProvider[]
) {
  return async function decideModality(
    state: Pick<ChiefComplaintGraphState, "contentUnits">,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<ChiefComplaintGraphState, "modalityPlan">> {
    const modalityPlan = await decideModalityComposition(
      runtime,
      state.contentUnits,
      producibleModalities(registry),
      lgRuntime?.context
    );
    return { modalityPlan };
  };
}

function makeRenderPartsDirect(registry: ModalityProvider[]) {
  return async function renderParts(
    state: Pick<ChiefComplaintGraphState, "contentUnits">,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<ChiefComplaintGraphState, "case">> {
    const plan = defaultPlanFor(state.contentUnits as ContentUnit[], registry);
    const chiefComplaint = await renderRequests(
      registry,
      plan[CHIEF_COMPLAINT_UNIT_KEY] ?? [],
      lgRuntime?.context
    );
    return { case: { chiefComplaint } };
  };
}

function makeRenderPartsPlanned(registry: ModalityProvider[]) {
  return async function renderParts(
    state: Pick<ChiefComplaintGraphState, "modalityPlan">,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<ChiefComplaintGraphState, "case">> {
    const chiefComplaint = await renderRequests(
      registry,
      state.modalityPlan[CHIEF_COMPLAINT_UNIT_KEY] ?? [],
      lgRuntime?.context
    );
    return { case: { chiefComplaint } };
  };
}

/**
 * `chiefComplaintGraph`: `generate_content` (an ordinary LLM call, always
 * runs) → `decide_modality` (compiled in only when `modalityRegistry` has
 * more than one entry — issue 13 §4) → `render_parts` (calls every planned
 * provider concurrently and reassembles the result in PLANNED order, not
 * completion order — see `modality/pipeline.ts`'s `renderRequests`, the same
 * shape as `medicalBasis/registry.ts`'s `resolveAllFragments`, for the same
 * reason, issue 13 §5).
 *
 * The two branches below are written out in full rather than conditionally
 * chained, mirroring `caseGraph.ts`'s `assembleCaseGraph` and
 * `02case-generation/index.ts`'s `buildCaseGenerationGraph`: LangGraph
 * accumulates node names into the builder's type parameter, so a
 * conditionally-extended builder loses the very typing that makes
 * `addEdge(...)` checkable. An empty registry is rejected immediately,
 * below — the absent-capability-⇒-absent-node rule taken to its limit: zero
 * capability is not a compilable shape at all.
 *
 * Known limitation, recorded rather than fixed here (issue 13 §6):
 * rendering runs INSIDE this subgraph, i.e. before translate-out. With the
 * translation sandwich on, a modality is rendered from an ENGLISH `alt`, and
 * its bytes are never translated — only `alt` is (issue 12). Fine for a
 * plain-text part (the only kind that exists today); not fine for an image
 * with burnt-in annotations, speech, or any rendering where meaning lives in
 * the bytes rather than the retained `alt`. The fix is a real future
 * change — move rendering to a post-translation phase — and it stays a
 * *move*, not a rewrite, only because `generate_content`, `decide_modality`
 * and the provider-calling step are distinct nodes here. Do not collapse
 * them into one node to "simplify" this graph.
 */
export function buildChiefComplaintGraph(
  runtime: GraphRuntime,
  modalityRegistry: ModalityProvider[],
  traceNode: ReturnType<typeof createTraceNode>
) {
  if (modalityRegistry.length === 0) {
    throw new EmptyModalityRegistryError();
  }

  if (modalityRegistry.length === 1) {
    return new StateGraph(ChiefComplaintGraphStateSchema, RequestContextSchema)
      .addNode(
        "generate_content",
        traceNode(
          "generate_content",
          makeGenerateContent(runtime),
          "Generating chief complaint"
        )
      )
      .addNode(
        "render_parts",
        traceNode(
          "render_parts",
          makeRenderPartsDirect(modalityRegistry),
          "Rendering chief complaint content"
        )
      )
      .addEdge(START, "generate_content")
      .addEdge("generate_content", "render_parts")
      .addEdge("render_parts", END)
      .compile();
  }

  return new StateGraph(ChiefComplaintGraphStateSchema, RequestContextSchema)
    .addNode(
      "generate_content",
      traceNode(
        "generate_content",
        makeGenerateContent(runtime),
        "Generating chief complaint"
      )
    )
    .addNode(
      "decide_modality",
      traceNode(
        "decide_modality",
        makeDecideModality(runtime, modalityRegistry),
        "Deciding chief complaint modality"
      )
    )
    .addNode(
      "render_parts",
      traceNode(
        "render_parts",
        makeRenderPartsPlanned(modalityRegistry),
        "Rendering chief complaint content"
      )
    )
    .addEdge(START, "generate_content")
    .addEdge("generate_content", "decide_modality")
    .addEdge("decide_modality", "render_parts")
    .addEdge("render_parts", END)
    .compile();
}
