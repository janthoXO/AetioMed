import { END, START, StateGraph, type Runtime } from "@langchain/langgraph";
import z from "zod";
import { CaseGenerationStateSchema } from "../../../state.js";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/core/graph/utils/context.js";
import { renderUserInstructions } from "@/core/graph/utils/prompt.js";
import {
  PlannedPartSchema,
  type ModalityProvider,
} from "@/core/graph/modality/ports.js";
import { renderPlan } from "@/core/graph/modality/pipeline.js";
import { EmptyModalityRegistryError } from "@/core/graph/modality/registry.js";
import {
  planChiefComplaint,
  CHIEF_COMPLAINT_UNIT_KEY,
} from "@/core/graph/03aigateway/chiefComplaint.aigateway.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";

const ChiefComplaintGraphStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  case: true,
}).extend({
  outline: z.string(),
  // Content-unit key -> its ORDERED planned render requests (issue 21 §1):
  // replaces the old `contentUnits`/`modalityPlan` pair now that planning
  // happens BEFORE any prose is generated, not after.
  plan: z.record(z.string(), z.array(PlannedPartSchema)).default({}),
});

type ChiefComplaintGraphState = z.infer<typeof ChiefComplaintGraphStateSchema>;

// This graph is `addNode`'d into `buildFieldGenerationGraph` alongside
// `anamnesisGraph`, fanned out in parallel by `Send` from `outline_evaluate`
// (issue 17 §0/§1). A compiled subgraph writes back its ENTIRE state schema
// unless told otherwise, so without an explicit `output` here, the parallel
// fan-out makes `diagnosis`, `userInstructions` and `outline` each receive
// two values in one superstep — `LastValue` channels, which accept exactly
// one, so LangGraph throws `INVALID_CONCURRENT_GRAPH_UPDATE`. `.pick()` off
// this graph's own state schema (not a hand-written duplicate) so the
// picked `case` channel keeps the identical reducer registration.
const ChiefComplaintOutputSchema = ChiefComplaintGraphStateSchema.pick({
  case: true,
});

function makePlanContent(
  runtime: GraphRuntime,
  providers: ModalityProvider<unknown>[]
) {
  return async function planContent(
    state: Pick<
      ChiefComplaintGraphState,
      "diagnosis" | "outline" | "userInstructions"
    >,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<ChiefComplaintGraphState, "plan">> {
    const plan = await planChiefComplaint(
      runtime,
      state.diagnosis,
      state.outline,
      providers,
      renderUserInstructions(state.userInstructions),
      lgRuntime?.context
    );
    return { plan };
  };
}

function makeRenderParts(
  runtime: GraphRuntime,
  providers: ModalityProvider<unknown>[]
) {
  return async function renderParts(
    state: Pick<ChiefComplaintGraphState, "plan">,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<ChiefComplaintGraphState, "case">> {
    const rendered = await renderPlan(
      providers,
      state.plan,
      lgRuntime?.context,
      runtime.log
    );
    return { case: { chiefComplaint: rendered[CHIEF_COMPLAINT_UNIT_KEY] } };
  };
}

/**
 * `chiefComplaintGraph`: `plan_content` (one LLM call planning an ORDERED
 * list of render requests per content unit — here, always exactly one,
 * keyed `"chiefComplaint"`) → `render_parts` (groups every planned request
 * by provider id, calls each provider's `render` once with its whole batch,
 * and reassembles the result in PLANNED order, not completion order — see
 * `modality/pipeline.ts`'s `renderPlan`).
 *
 * No registry-size branching (issue 21 §1/§7): the planner always runs, for
 * every field, even when the field's registry holds a single text
 * provider — a deliberate, accepted extra LLM call per field per request in
 * exchange for one uniform shape. The only registry check left is empty ⇒
 * `EmptyModalityRegistryError`, at build time — zero capability is not a
 * compilable shape at all.
 *
 * Known limitation, recorded rather than fixed here (issue 13 §6, still
 * true under the planner): rendering runs INSIDE this subgraph, i.e. before
 * translate-out. With the translation sandwich on, a modality is rendered
 * from an ENGLISH plan, and its bytes are never translated — only `alt` is
 * (issue 12). Fine for a plain-text part (the only kind that exists today);
 * not fine for an image with burnt-in annotations, speech, or any
 * rendering where meaning lives in the bytes rather than the retained
 * `alt`. The fix is a real future change — move rendering to a
 * post-translation phase — and it stays a *move*, not a rewrite, only
 * because `plan_content` and `render_parts` are distinct nodes here. Do not
 * collapse them into one node to "simplify" this graph.
 */
export function buildChiefComplaintGraph(
  runtime: GraphRuntime,
  providers: ModalityProvider<unknown>[],
  traceNode: ReturnType<typeof createTraceNode>
) {
  if (providers.length === 0) {
    throw new EmptyModalityRegistryError();
  }

  return new StateGraph(ChiefComplaintGraphStateSchema, {
    context: RequestContextSchema,
    output: ChiefComplaintOutputSchema,
  })
    .addNode(
      "plan_content",
      traceNode(
        "plan_content",
        makePlanContent(runtime, providers),
        "Planning chief complaint"
      )
    )
    .addNode(
      "render_parts",
      traceNode(
        "render_parts",
        makeRenderParts(runtime, providers),
        "Rendering chief complaint content"
      )
    )
    .addEdge(START, "plan_content")
    .addEdge("plan_content", "render_parts")
    .addEdge("render_parts", END)
    .compile();
}
