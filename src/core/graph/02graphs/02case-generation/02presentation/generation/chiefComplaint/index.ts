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
  // Content-unit key -> ORDERED planned render requests.
  plan: z.record(z.string(), z.array(PlannedPartSchema)).default({}),
});

type ChiefComplaintGraphState = z.infer<typeof ChiefComplaintGraphStateSchema>;

// Mounted in `buildFieldGenerationGraph`, `Send`-fanned in parallel with `anamnesisGraph`. Subgraph writes back ENTIRE state unless `output` set; parallel writes to `diagnosis`/`userInstructions`/`outline` (`LastValue`) throw `INVALID_CONCURRENT_GRAPH_UPDATE`. `.pick()` off own state schema keeps reducer registration.
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
 * `plan_content` (one LLM call planning ORDERED render requests per unit; here always one, key `"chiefComplaint"`) → `render_parts` (groups requests by provider id, one `render` per provider with whole batch, results in PLANNED order; see `modality/pipeline.ts`'s `renderPlan`).
 *
 * No registry-size branching: planner always runs. Empty registry ⇒ `EmptyModalityRegistryError` at build time.
 *
 * Limitation: rendering runs before translate-out. Sandwich on: modality rendered from ENGLISH plan, bytes never translated, only `alt`. Fine for text; not for image with burnt-in text or speech. Keep `plan_content`/`render_parts` separate so rendering can move post-translation.
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
