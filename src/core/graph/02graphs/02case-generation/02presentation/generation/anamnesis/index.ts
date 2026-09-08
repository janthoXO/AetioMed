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
  // Category name -> its ORDERED planned render requests (issue 21 §1):
  // replaces the old `contentUnits`/`modalityPlan` pair now that planning
  // happens BEFORE any prose is generated, not after — the planner itself
  // is what enumerates categories (`03aigateway/anamnesis.aigateway.ts`'s
  // `planAnamnesis`), not a separate generation pass.
  plan: z.record(z.string(), z.array(PlannedPartSchema)).default({}),
});

type AnamnesisGraphState = z.infer<typeof AnamnesisGraphStateSchema>;

// This graph is `addNode`'d into `buildFieldGenerationGraph` alongside
// `chiefComplaintGraph`, fanned out in parallel by `Send` from
// `outline_evaluate` (issue 17 §0/§1) — see `chiefComplaint/index.ts`'s
// matching comment for why an explicit `output` is required here too.
// `.pick()` off this graph's own state schema, never a hand-written
// duplicate, so the picked `case` channel keeps the identical reducer
// registration.
const AnamnesisOutputSchema = AnamnesisGraphStateSchema.pick({ case: true });

/**
 * Reorders a plan's category keys to match the catalogue's category order
 * rather than whatever order the LLM happened to emit them in — the
 * categories `planAnamnesis` enumerates in its schema
 * (`runtime.catalogs.anamnesis.list()`) are the source of truth for order,
 * downstream prompts depend on it staying stable, and an LLM's array order
 * is not a contract. Any category the catalogue does not know about (should
 * not happen — the schema constrains to exactly the catalogue's categories)
 * is appended in its original position rather than dropped.
 */
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

/**
 * `anamnesisGraph`: same two-node shape as `chiefComplaint/index.ts`
 * (`plan_content` → `render_parts`), except the plan has ONE content unit
 * PER CATEGORY, so `render_parts` reassembles the per-category answers into
 * `Anamnesis` in CATALOGUE order — see `orderByCatalogue` above for why
 * that reassembly trusts the catalogue's order rather than the LLM's array
 * order. See `chiefComplaint/index.ts`'s doc comment for why there is no
 * registry-size branching and for the pre-translate-out known limitation
 * (issue 13 §6) that applies identically here.
 */
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
