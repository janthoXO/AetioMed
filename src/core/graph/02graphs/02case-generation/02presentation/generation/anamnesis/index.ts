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
  type ModalityPlan,
  type ModalityProvider,
} from "@/core/graph/modality/ports.js";
import { renderPlan } from "@/core/graph/modality/pipeline.js";
import { EmptyModalityRegistryError } from "@/core/graph/modality/registry.js";
import { planAnamnesis } from "@/core/graph/03aigateway/anamnesis.aigateway.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";

const AnamnesisGraphStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  case: true,
}).extend({
  outline: z.string(),
  // Category name -> ORDERED planned render requests. Planner enumerates categories (`planAnamnesis`).
  plan: z.record(z.string(), z.array(PlannedPartSchema)).default({}),
});

type AnamnesisGraphState = z.infer<typeof AnamnesisGraphStateSchema>;

// Mounted in `buildFieldGenerationGraph`, `Send`-fanned in parallel with `chiefComplaintGraph`; explicit `output` required (see `chiefComplaint/index.ts`). `.pick()` off own state schema.
const AnamnesisOutputSchema = AnamnesisGraphStateSchema.pick({ case: true });

/** Reorders plan's category keys to catalogue order; LLM array order is no contract. Unknown categories kept at original position, not dropped. */
function orderByCatalogue(keys: string[], catalogueOrder: string[]): string[] {
  const rank = new Map(catalogueOrder.map((category, i) => [category, i]));
  return [...keys].sort((a, b) => {
    const ra = rank.get(a) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });
}

function makePlanContent(
  runtime: GraphRuntime,
  providers: ModalityProvider<unknown>[]
) {
  return async function planContent(
    state: Pick<
      AnamnesisGraphState,
      "diagnosis" | "outline" | "userInstructions"
    >,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<AnamnesisGraphState, "plan">> {
    const plan = await planAnamnesis(
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
    state: Pick<AnamnesisGraphState, "plan">,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<AnamnesisGraphState, "case">> {
    const rendered = await renderPlan(
      providers,
      state.plan,
      lgRuntime?.context,
      runtime.log
    );
    const orderedCategories = orderByCatalogue(
      Object.keys(state.plan as ModalityPlan),
      runtime.catalogs.anamnesis.list() ?? []
    );
    const anamnesis = orderedCategories.map((category) => ({
      category,
      answer: rendered[category]!,
    }));
    return { case: { anamnesis } };
  };
}

/** `plan_content` → `render_parts` like `chiefComplaint/index.ts`, one content unit PER CATEGORY; `render_parts` reassembles in CATALOGUE order (`orderByCatalogue`). Registry-size and translate-out caveats: see `chiefComplaint/index.ts`. */
export function buildAnamnesisGraph(
  runtime: GraphRuntime,
  providers: ModalityProvider<unknown>[],
  traceNode: ReturnType<typeof createTraceNode>
) {
  if (providers.length === 0) {
    throw new EmptyModalityRegistryError();
  }

  return new StateGraph(AnamnesisGraphStateSchema, {
    context: RequestContextSchema,
    output: AnamnesisOutputSchema,
  })
    .addNode(
      "plan_content",
      traceNode(
        "plan_content",
        makePlanContent(runtime, providers),
        "Planning anamnesis"
      )
    )
    .addNode(
      "render_parts",
      traceNode(
        "render_parts",
        makeRenderParts(runtime, providers),
        "Rendering anamnesis content"
      )
    )
    .addEdge(START, "plan_content")
    .addEdge("plan_content", "render_parts")
    .addEdge("render_parts", END)
    .compile();
}
