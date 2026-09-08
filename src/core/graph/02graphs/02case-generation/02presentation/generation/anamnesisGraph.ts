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

const AnamnesisGraphStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  case: true,
}).extend({
  outline: z.string(),
  // One content unit per anamnesis category, in CATALOGUE order (see
  // `orderByCatalogue` below) — issue 13 §2: "Keep category order stable —
  // it comes from the catalogue and downstream prompts depend on it."
  contentUnits: z
    .array(z.object({ key: z.string(), text: z.string() }))
    .default([]),
  modalityPlan: z
    .record(z.string(), z.array(ModalityRenderRequestSchema))
    .default({}),
});

type AnamnesisGraphState = z.infer<typeof AnamnesisGraphStateSchema>;

/**
 * Reorders content units to match the catalogue's category order rather
 * than whatever order the LLM happened to emit them in — the categories the
 * gateway call enumerates in its schema (`runtime.catalogs.anamnesis.list()`)
 * are the source of truth for order, downstream prompts depend on it staying
 * stable, and an LLM's array order is not a contract. Any category the
 * catalogue does not know about (should not happen — the schema constrains
 * to exactly the catalogue's categories) is appended in its original
 * position rather than dropped.
 */
function orderByCatalogue(
  units: ContentUnit[],
  catalogueOrder: string[]
): ContentUnit[] {
  const rank = new Map(catalogueOrder.map((category, i) => [category, i]));
  return [...units].sort((a, b) => {
    const ra = rank.get(a.key) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b.key) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });
}

function makeGenerateContent(runtime: GraphRuntime) {
  return async function generateContent(
    state: Pick<
      AnamnesisGraphState,
      "diagnosis" | "outline" | "userInstructions"
    >,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<AnamnesisGraphState, "contentUnits">> {
    // Reuses the existing gateway call and its z.string()-`answer`-based
    // schema unchanged (issue 13 §0/§2) — this is exactly what the old
    // single-node `anamnesis_generate` did. `textOf()` (issue 11) reads the
    // canonical text back out of the single text part the gateway wraps
    // each answer in, so no prompt or schema here is new.
    const anamnesis = await generationTools.generateAnamnesisFromOutline.invoke(
      {
        diagnosis: state.diagnosis,
        outline: state.outline,
        userInstructions: renderUserInstructions(state.userInstructions),
      },
      runtime,
      lgRuntime?.context
    );

    const units: ContentUnit[] = anamnesis.map((field) => ({
      key: field.category,
      text: textOf(field.answer),
    }));

    return {
      contentUnits: orderByCatalogue(
        units,
        runtime.catalogs.anamnesis.list() ?? []
      ),
    };
  };
}

function makeDecideModality(
  runtime: GraphRuntime,
  registry: ModalityProvider[]
) {
  return async function decideModality(
    state: Pick<AnamnesisGraphState, "contentUnits">,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<AnamnesisGraphState, "modalityPlan">> {
    const modalityPlan = await decideModalityComposition(
      runtime,
      state.contentUnits,
      producibleModalities(registry),
      lgRuntime?.context
    );
    return { modalityPlan };
  };
}

/** Renders every category's planned requests and reassembles `Anamnesis`, category order preserved. */
async function renderAnamnesis(
  registry: ModalityProvider[],
  contentUnits: ContentUnit[],
  plan: Record<string, { modality: string; alt: string }[]>,
  context: RequestContext | undefined
): Promise<Pick<AnamnesisGraphState, "case">> {
  const anamnesis = await Promise.all(
    contentUnits.map(async (unit) => ({
      category: unit.key,
      answer: await renderRequests(registry, plan[unit.key] ?? [], context),
    }))
  );
  return { case: { anamnesis } };
}

function makeRenderPartsDirect(registry: ModalityProvider[]) {
  return async function renderParts(
    state: Pick<AnamnesisGraphState, "contentUnits">,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<AnamnesisGraphState, "case">> {
    const plan = defaultPlanFor(state.contentUnits, registry);
    return renderAnamnesis(
      registry,
      state.contentUnits,
      plan,
      lgRuntime?.context
    );
  };
}

function makeRenderPartsPlanned(registry: ModalityProvider[]) {
  return async function renderParts(
    state: Pick<AnamnesisGraphState, "contentUnits" | "modalityPlan">,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<AnamnesisGraphState, "case">> {
    return renderAnamnesis(
      registry,
      state.contentUnits,
      state.modalityPlan,
      lgRuntime?.context
    );
  };
}

/**
 * `anamnesisGraph`: same three-role shape as `chiefComplaintGraph`
 * (`generate_content` → `decide_modality`, compiled in only when
 * `modalityRegistry` has more than one entry → `render_parts`), except the
 * field value is an ARRAY of `{ category, answer }`, so the plan is per
 * answer and `render_parts` reassembles per category — see
 * `orderByCatalogue` above for why that reassembly trusts the catalogue's
 * order rather than the LLM's array order. See `chiefComplaintGraph.ts`'s
 * doc comment for why the two branches below are written out in full, and
 * for the pre-translate-out known limitation (issue 13 §6) that applies
 * identically here.
 */
export function buildAnamnesisGraph(
  runtime: GraphRuntime,
  modalityRegistry: ModalityProvider[],
  traceNode: ReturnType<typeof createTraceNode>
) {
  if (modalityRegistry.length === 0) {
    throw new EmptyModalityRegistryError();
  }

  if (modalityRegistry.length === 1) {
    return new StateGraph(AnamnesisGraphStateSchema, RequestContextSchema)
      .addNode(
        "generate_content",
        traceNode(
          "generate_content",
          makeGenerateContent(runtime),
          "Generating anamnesis"
        )
      )
      .addNode(
        "render_parts",
        traceNode(
          "render_parts",
          makeRenderPartsDirect(modalityRegistry),
          "Rendering anamnesis content"
        )
      )
      .addEdge(START, "generate_content")
      .addEdge("generate_content", "render_parts")
      .addEdge("render_parts", END)
      .compile();
  }

  return new StateGraph(AnamnesisGraphStateSchema, RequestContextSchema)
    .addNode(
      "generate_content",
      traceNode(
        "generate_content",
        makeGenerateContent(runtime),
        "Generating anamnesis"
      )
    )
    .addNode(
      "decide_modality",
      traceNode(
        "decide_modality",
        makeDecideModality(runtime, modalityRegistry),
        "Deciding anamnesis modality"
      )
    )
    .addNode(
      "render_parts",
      traceNode(
        "render_parts",
        makeRenderPartsPlanned(modalityRegistry),
        "Rendering anamnesis content"
      )
    )
    .addEdge(START, "generate_content")
    .addEdge("generate_content", "decide_modality")
    .addEdge("decide_modality", "render_parts")
    .addEdge("render_parts", END)
    .compile();
}
