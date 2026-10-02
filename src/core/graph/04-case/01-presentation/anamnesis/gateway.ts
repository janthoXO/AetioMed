import type { Language } from "@/core/graph/shared/domain/Language.js";
import z from "zod";
import {
  buildPrompt,
  buildSystemPrompt,
  renderSchemaForPrompt,
  section,
  summarizeValidationError,
} from "@/core/graph/shared/prompt/prompt.js";
import type { Diagnosis } from "@/core/graph/shared/domain/Diagnosis.js";
import { retry } from "@/core/graph/shared/prompt/retry.js";
import type { RequestContext } from "@/core/graph/utils/context.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import {
  buildCompositionSchema,
  plansByKey,
  describeProviders,
} from "@/core/graph/shared/modality/composition.js";
import type {
  ModalityPlan,
  ModalityProvider,
} from "@/core/graph/shared/modality/ports.js";

/**
 * Plans anamnesis rendering: one LLM call, one content unit per catalogue
 * category, each an ordered list of render requests. `alt` authored here by
 * planner, never by a provider.
 */
export async function planAnamnesis(
  runtime: GraphRuntime,
  language: Language | undefined,
  diagnosis: Diagnosis,
  outline: string,
  providers: ModalityProvider<unknown>[],
  userInstructions?: string,
  context?: RequestContext
): Promise<ModalityPlan> {
  // `undefined` = freeform (no category catalogue): planner names unit keys.
  // Do not substitute a default list; clinical content belongs in catalogue.
  const categories = runtime.catalogs.anamnesis.list();
  const schema = buildCompositionSchema(providers, categories);

  // User-facing: planned `alt` becomes user-visible content via the renderer.
  const systemPrompt = buildSystemPrompt(
    language,
    section(
      "Role",
      `You are an AI planning data for a medical training simulator.
Your current task is to plan how the Anamnesis (medical history) facts from the provided Case Outline should be rendered, in the patient's own voice. The outline is the single source of truth — you do not decide any clinical facts yourself, only how to present them.`
    ),

    section(
      "Requirements",
      `- The rendered text must read as the PATIENT filling out an intake form: subjective voice, layman's terms, personal tone (e.g., "My chest feels heavy" instead of "Patient presents with angina"), adapted to the patient's age and demographic as defined in the outline.
- Plan exactly one content unit per required intake form category, keyed by that category's exact name.
- Use ONLY the facts specified in the outline. Do not invent symptoms, history items, medications, or details beyond the outline; your job is voice, format and rendering choice.
- Prefer a single request against the "text" provider carrying each category's whole answer, unless another available provider would clearly add value.
- Each request's "alt" is the complete content of that part: every fact the rendered part states, written out in full, in the patient voice above. Later diagnostic steps read ONLY "alt", never the rendered part, so a fact missing from "alt" does not exist for them. The provider renders "alt" into the final wording and never invents facts; give the "text" provider an empty input object.
- Return ONLY the JSON object, no additional text like prefix or suffix.`
    ),

    section(
      categories
        ? "Required intake form categories to plan"
        : "Intake form categories",
      categories
        ? categories.join(", ")
        : "No category list is configured for this deployment — choose the standard intake-form categories appropriate to this case and name each content unit after the category it covers."
    ),

    section("Available providers", describeProviders(providers)),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(schema)}`
    )
  );

  const userPrompt = buildPrompt(
    section("Target diagnosis", `${diagnosis.name} ${diagnosis.icd ?? ""}`),

    section("Case outline", outline),

    section("Additional instructions", userInstructions)
  );

  console.debug(
    `[PlanAnamnesis] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  const plans = await retry(
    async (attempt: number, previousError?: Error) => {
      const result = (await runtime.llm.structured(
        { role: "generator", temperature: "creative" },
        {
          system: systemPrompt,
          user:
            userPrompt +
            (previousError
              ? `\n\nPrevious generation error: ${summarizeValidationError(previousError)}`
              : ""),
        },
        schema,
        context
      )) as {
        plans: Parameters<
          typeof plansByKey<{ requests: ModalityPlan[string] }>
        >[0];
      };

      console.debug(
        `[PlanAnamnesis] [Attempt ${attempt}] LLM raw Response:\n`,
        JSON.stringify(result, null, 2)
      );

      return result.plans;
    },
    2,
    0,
    (error, attempt) => {
      const msg = `[PlanAnamnesis] Attempt ${attempt} failed with error: ${error.message}`;
      console.error(msg);
      runtime.log.error(msg);
    }
  );

  return Object.fromEntries(
    Object.entries(plansByKey(plans)).map(([key, unit]) => [key, unit.requests])
  );
}

/**
 * Text rendering for anamnesis: whole batch of planned `alt`s (all
 * categories) in ONE LLM call, per `ModalityProvider.render` batch contract.
 */
export async function renderAnamnesisTexts(
  runtime: GraphRuntime,
  language: Language | undefined,
  contents: string[],
  context?: RequestContext
): Promise<string[]> {
  const schema = z.object({
    texts: z
      .array(z.string().min(1))
      .length(contents.length)
      .describe(
        "Rendered patient-voice text, one per content, in the same order"
      ),
  });

  const systemPrompt = buildSystemPrompt(
    language,
    section(
      "Role",
      `You are an AI generating data for a medical training simulator.
You will be given one or more contents, each the complete facts of one anamnesis answer to render in the PATIENT's own voice, as if filling out an intake form. Render EXACTLY those facts — you do not decide clinical facts, only wording. A content may be written in a different language than the one you write in; render its meaning.`
    ),

    section(
      "Requirements",
      `- Write in the PATIENT's subjective voice, layman's terms, personal tone (e.g., "My chest feels heavy" instead of "Patient presents with angina").
- Render each content into its own text; invent nothing beyond what the content states.
- Return exactly ${contents.length} text(s), in the same order as the contents.
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
      "Contents to render",
      contents.map((content, i) => `### ${i + 1}\n${content}`).join("\n\n")
    )
  );

  console.debug(
    `[RenderAnamnesisTexts] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  return retry(
    async (attempt: number, previousError?: Error) => {
      const result = await runtime.llm.structured(
        { role: "generator", temperature: "creative" },
        {
          system: systemPrompt,
          user:
            userPrompt +
            (previousError
              ? `\n\nPrevious generation error: ${summarizeValidationError(previousError)}`
              : ""),
        },
        schema,
        context
      );

      console.debug(
        `[RenderAnamnesisTexts] [Attempt ${attempt}] LLM raw Response:\n`,
        JSON.stringify(result, null, 2)
      );

      return result.texts;
    },
    2,
    0,
    (error, attempt) => {
      const msg = `[RenderAnamnesisTexts] Attempt ${attempt} failed with error: ${error.message}`;
      console.error(msg);
      runtime.log.error(msg);
    }
  );
}
