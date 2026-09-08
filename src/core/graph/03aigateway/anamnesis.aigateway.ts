import z from "zod";
import type { AnamnesisCategory } from "../models/Anamnesis.js";
import type { Language } from "../models/Language.js";
import { handleLangchainError } from "../utils/llm.js";
import {
  buildPrompt,
  buildSystemPrompt,
  renderSchemaForPrompt,
  section,
  summarizeValidationError,
} from "../utils/prompt.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { retry } from "../utils/retry.js";
import type { RequestContext } from "../utils/context.js";
import { translateTermsKeyed } from "./translate.helper.js";
import type { GraphRuntime } from "../runtime.js";
import {
  buildCompositionSchema,
  describeProviders,
} from "../modality/composition.js";
import type { ModalityPlan, ModalityProvider } from "../modality/ports.js";

/**
 * Plans the anamnesis's rendering (issue 21 §1/§5): ONE LLM call that still
 * decides the case content — the Role/Requirements below are the old direct
 * generator's prompt, kept verbatim in substance — but instead of returning
 * prose per category directly, it returns one content unit PER CATALOGUE
 * CATEGORY, each an ORDERED list of render requests. `alt` is authored
 * HERE, by the planner, never by a provider (issue 21 §1).
 */
export async function planAnamnesis(
  runtime: GraphRuntime,
  diagnosis: Diagnosis,
  outline: string,
  providers: ModalityProvider<unknown>[],
  userInstructions?: string,
  context?: RequestContext
): Promise<ModalityPlan> {
  // `undefined` in freeform mode (no configured category catalogue), which
  // `buildCompositionSchema` turns into a planner-named unit key rather than
  // a fixed enum — the same freedom `buildAnamnesisFieldSchema()` gave the
  // old direct generator. Do not substitute a default list here; that would
  // put opinionated clinical content in code instead of the catalogue.
  const categories = runtime.catalogs.anamnesis.list();
  const schema = buildCompositionSchema(providers, categories);

  // User-facing (issue 09 §3): a planned `alt`/instruction both become
  // user-visible content once rendered.
  const systemPrompt = buildSystemPrompt(
    runtime,
    "user-facing",
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
- Each request's "alt" is a self-contained instruction describing exactly what that rendered part should convey, in the patient voice above — a provider renders it verbatim, it never invents facts.
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
      const result = (await runtime.llm
        .for({ role: "generator", temperature: "creative" }, context?.llmConfig)
        .withStructuredOutput(schema)
        .invoke(
          [
            new SystemMessage(systemPrompt),
            new HumanMessage(
              userPrompt +
                (previousError
                  ? `\n\nPrevious generation error: ${summarizeValidationError(previousError)}`
                  : "")
            ),
          ],
          context?.signal !== undefined ? { signal: context.signal } : undefined
        )
        .catch((error) => {
          handleLangchainError(error);
        })) as { plans: { key: string; requests: ModalityPlan[string] }[] };

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

  return Object.fromEntries(plans.map((p) => [p.key, p.requests]));
}

/**
 * The anamnesis field's TEXT-rendering call (issue 21 §4): renders an
 * entire batch of planner-authored instructions — potentially spanning
 * every category the plan touched — in ONE LLM call. The batching is the
 * whole point of `ModalityProvider.render`'s batch-in/batch-out contract
 * (`modality/ports.ts`): a loop of single calls here would defeat the
 * design. Keeps the old direct generator's tuned patient voice; only the
 * FACTS now arrive via each instruction.
 */
export async function renderAnamnesisTexts(
  runtime: GraphRuntime,
  instructions: string[],
  context?: RequestContext
): Promise<string[]> {
  const schema = z.object({
    texts: z
      .array(z.string().min(1))
      .length(instructions.length)
      .describe(
        "Rendered patient-voice text, one per instruction, in the same order"
      ),
  });

  const systemPrompt = buildSystemPrompt(
    runtime,
    "user-facing",
    section(
      "Role",
      `You are an AI generating data for a medical training simulator.
You will be given one or more instructions, each fully describing one anamnesis answer to render in the PATIENT's own voice, as if filling out an intake form. Render EXACTLY what each instruction says — you do not decide clinical facts, only wording.`
    ),

    section(
      "Requirements",
      `- Write in the PATIENT's subjective voice, layman's terms, personal tone (e.g., "My chest feels heavy" instead of "Patient presents with angina").
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
    `[RenderAnamnesisTexts] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  return retry(
    async (attempt: number, previousError?: Error) => {
      const result = await runtime.llm
        .for({ role: "generator", temperature: "creative" }, context?.llmConfig)
        .withStructuredOutput(schema)
        .invoke(
          [
            new SystemMessage(systemPrompt),
            new HumanMessage(
              userPrompt +
                (previousError
                  ? `\n\nPrevious generation error: ${summarizeValidationError(previousError)}`
                  : "")
            ),
          ],
          context?.signal !== undefined ? { signal: context.signal } : undefined
        )
        .catch((error) => {
          handleLangchainError(error);
        });

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

/**
 * Generates translations of anamnesis categories from English to a target language using an LLM.
 * @param englishCategories the anamnesis categories in English to translate
 * @param language the target language to translate the categories into
 * @returns a record mapping English categories to their translations in the target language
 */
export async function generateAnamnesisCategoriesFromEnglish(
  runtime: GraphRuntime,
  englishCategories: AnamnesisCategory[],
  language: Language,
  context?: RequestContext
): Promise<Record<AnamnesisCategory, AnamnesisCategory>> {
  return translateTermsKeyed(runtime, {
    logTag: "GenerateAnamnesisCategoriesFromEnglish",
    taskDescription: `Translate the provided anamnesis categories from English to a target language.`,
    contextLines: [`Target language: ${language}`],
    terms: englishCategories,
    context,
  });
}
