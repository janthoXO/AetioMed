import type { Language } from "@/core/graph/shared/domain/Language.js";
import { retry } from "@/core/graph/shared/prompt/retry.js";
import z from "zod";
import {
  buildPrompt,
  buildSystemPrompt,
  renderSchemaForPrompt,
  section,
} from "@/core/graph/shared/prompt/prompt.js";
import type { Diagnosis } from "@/core/graph/shared/domain/Diagnosis.js";
import {
  ProcedureRelevanceSchema,
  type PlannedProcedure,
  type ProcedureRelevance,
} from "@/core/graph/shared/domain/Procedure.js";
import {
  refLabel,
  type ProcedureRef,
} from "@/core/graph/shared/domain/ProcedureTree.js";
import type { RequestContext } from "@/core/graph/utils/context.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import {
  buildCompositionSchema,
  buildUnitPlanSchema,
  describeProviders,
} from "@/core/graph/shared/modality/composition.js";
import type {
  ModalityProvider,
  PlannedPart,
} from "@/core/graph/shared/modality/ports.js";
import { OUTLINE_SECTIONS } from "@/core/graph/shared/outline/segments.js";
import {
  presentationSection,
  diagnosisLabel,
  errorFeedback,
  type Presentation,
} from "./prompt.js";

// ─── 2. planProcedureResults ──────────────────────────────────────────────────

/**
 * Per-procedure plan schema: a composition unit (`{ requests }`) plus
 * `relevance`, both from one non-blinded call, keyed by procedure name.
 * `unitKeys` always passed: procedure names known beforehand, never freeform.
 */
function buildProcedureResultPlanSchema(
  providers: ModalityProvider<unknown>[],
  procedureNames: string[]
) {
  return buildCompositionSchema(
    providers,
    procedureNames,
    buildUnitPlanSchema(providers).extend({
      relevance: ProcedureRelevanceSchema.describe(
        "Relevance of the procedure to the TRUE diagnosis"
      ),
    })
  );
}

/**
 * Non-blinded result step: given presentation, TRUE diagnosis and a batch of
 * procedures, PLANS result and `relevance` for each. Blinded solver can't judge
 * relevance. Rendering later, once, in `render_results` (`03procedure/index.ts`).
 *
 * `alt` rule differs here: blinded solver reasons over `alt` ONLY (no bytes
 * yet), so each `alt` must be a self-contained finding, not a label:
 *
 *   good: "Chest X-ray: consolidation of the left lower lobe with air bronchograms"
 *   bad:  "chest x-ray image"
 *
 * No test catches a bad one; solver just can't solve. See
 * `PlannedProcedureSchema` in `models/Procedure.ts`.
 */
export async function planProcedureResults(
  runtime: GraphRuntime,
  language: Language | undefined,
  presentation: Presentation,
  diagnosis: Diagnosis,
  procedureSteps: ProcedureRef[],
  providers: ModalityProvider<unknown>[],
  outline?: string,
  userInstructions?: string,
  context?: RequestContext
): Promise<PlannedProcedure[]> {
  const procedureLabels = procedureSteps.map(refLabel);
  const schema = buildProcedureResultPlanSchema(providers, procedureLabels);

  // User-facing: planned `alt`/instruction become user-visible content.
  const systemPrompt = buildSystemPrompt(
    language,
    section(
      "Role",
      `You are a medical simulator PLANNING realistic results for a batch of diagnostic procedures ordered at the same time.
The true diagnosis is known to you. Plan a result AND a relevance judgment for EACH procedure, clinically consistent with both the true diagnosis and the patient's presentation. You do not render any bytes yourself — you plan how each result should be rendered.
These procedures were chosen by a separate, BLINDED solver who does not know the true diagnosis — it ordered them based on the presentation alone, so some may turn out to be unnecessary or even contraindicated in hindsight.`
    ),

    section(
      "Rules",
      `- Provide exactly one plan entry per procedure in the batch, keyed by its exact label.
- Each plan's "alt" MUST be a self-contained statement of the clinical finding, not a bare label — a later step renders bytes from "alt" alone, without seeing anything else you produced. Write "Chest X-ray: consolidation of the left lower lobe with air bronchograms", not "chest x-ray image".
- Each finding must be clinically consistent with the true diagnosis. Use specific, realistic medical findings (e.g., exact lab values, imaging descriptions). Keep each finding concise (1–3 sentences).
- Prefer a single request against the "text" provider per procedure, unless another available provider would clearly add value.
- Judge "relevance" relative to the TRUE diagnosis, not the blinded solver's reasoning:
  - "obligatory": essential to establishing or confirming this diagnosis.
  - "optional": clinically reasonable and supportive, but not required for this diagnosis.
  - "contraindicated": not indicated, or potentially harmful/misleading, given this diagnosis — even if the blinded solver had a reasonable reason to order it without knowing the diagnosis.
- Return ONLY the JSON object, no additional text like prefix or suffix.`
    ),

    section("Available providers", describeProviders(providers)),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(schema)}`
    )
  );

  const userPrompt = buildPrompt(
    outline
      ? section(
          "Case blueprint",
          `Single source of truth — follow its "${OUTLINE_SECTIONS.procedures}" section, including any difficulty-driven ambiguity or borderline values it specifies:
${outline}`
        )
      : undefined,

    presentationSection(presentation),

    section("True diagnosis", diagnosisLabel(diagnosis)),

    section("Additional instructions", userInstructions),

    section(
      "Procedures ordered together in this batch",
      procedureLabels.map((label, i) => `${i + 1}. ${label}`).join("\n")
    ),

    `Plan clinically realistic results for these procedures.`
  );

  console.debug(
    `[PlanProcedureResults] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const plans = await retry(
      async (attempt, previousError) => {
        // Balanced: follow outline's workup strategy, plausible specific values.
        const res = (await runtime.llm.structured(
          { role: "generator", temperature: "balanced" },
          {
            system: systemPrompt,
            user: userPrompt + errorFeedback(previousError),
          },
          schema,
          context
        )) as {
          plans: Record<
            string,
            { requests: PlannedPart[]; relevance: ProcedureRelevance }
          >;
        };

        console.debug(
          `[PlanProcedureResults] [Attempt ${attempt}] Response:\n`,
          JSON.stringify(res, null, 2)
        );

        return res.plans;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[PlanProcedureResults] Attempt ${attempt} failed: ${error.message}`;
        console.error(msg);
        runtime.log.error(msg);
      }
    );

    // Schema requires exactly one plan per procedure label.
    return procedureSteps.map((step) => {
      const match = plans[refLabel(step)]!;
      return {
        path: step.path,
        name: step.name,
        relevance: match.relevance,
        parts: match.requests,
      };
    });
  } catch (error) {
    console.error("[PlanProcedureResults] Error:", error);
    throw error;
  }
}

// ─── procedure-result TEXT rendering ─────────────────────────────────────────

/**
 * Text rendering for procedure results: whole batch of planner instructions
 * (all procedures from `render_results`) in ONE LLM call, per
 * `ModalityProvider.render` batch contract. Renders whatever instruction the
 * plan supplied; case already solved, no blinded view to protect.
 */
export async function renderProcedureResultTexts(
  runtime: GraphRuntime,
  language: Language | undefined,
  instructions: string[],
  context?: RequestContext
): Promise<string[]> {
  const schema = z.object({
    texts: z
      .array(z.string().min(1))
      .length(instructions.length)
      .describe(
        "Rendered procedure-result text, one per instruction, in the same order"
      ),
  });

  // User-facing: student reads result text.
  const systemPrompt = buildSystemPrompt(
    language,
    section(
      "Role",
      `You are a medical simulator rendering procedure results for a clinical training simulator.
You will be given one or more instructions, each fully describing one procedure result to render. Render EXACTLY what each instruction says — you do not decide clinical facts, only wording.`
    ),

    section(
      "Rules",
      `- Use specific, professional medical terminology.
- Render each instruction into its own text; invent nothing beyond what the instruction states.
- Return exactly ${instructions.length} text(s), in the same order as the instructions.
- Return ONLY the JSON object, no additional text like prefix or suffix.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(schema)}`
    )
  );

  const userPrompt = buildPrompt(
    section(
      "Instructions to render",
      instructions
        .map((instruction, i) => `### ${i + 1}\n${instruction}`)
        .join("\n\n")
    )
  );

  console.debug(
    `[RenderProcedureResultTexts] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  return retry(
    async (attempt: number, previousError?: Error) => {
      const result = await runtime.llm.structured(
        { role: "generator", temperature: "balanced" },
        {
          system: systemPrompt,
          user: userPrompt + errorFeedback(previousError),
        },
        schema,
        context
      );

      console.debug(
        `[RenderProcedureResultTexts] [Attempt ${attempt}] Response:\n`,
        JSON.stringify(result, null, 2)
      );

      return result.texts;
    },
    2,
    0,
    (error, attempt) => {
      const msg = `[RenderProcedureResultTexts] Attempt ${attempt} failed with error: ${error.message}`;
      console.error(msg);
      runtime.log.error(msg);
    }
  );
}
