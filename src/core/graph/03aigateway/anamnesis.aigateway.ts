import {
  buildAnamnesisSchema,
  type Anamnesis,
  type AnamnesisCategory,
} from "../models/Anamnesis.js";
import { anamnesisCatalog } from "../catalog/index.js";
import { bus } from "@/core/graph/index.js";
import type { Language } from "../models/Language.js";
import { getCreativeLLM, handleLangchainError } from "../utils/llm.js";
import {
  buildPrompt,
  renderSchemaForPrompt,
  section,
  summarizeValidationError,
} from "../utils/prompt.js";
import z from "zod";
import type { Diagnosis } from "../models/Diagnosis.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { retry } from "../utils/retry.js";
import type { RequestContext } from "../utils/context.js";
import { translateTermsKeyed } from "./translate.helper.js";

export async function generateAnamnesis(
  diagnosis: Diagnosis,
  outline: string,
  userInstructions?: string,
  context?: RequestContext
): Promise<Anamnesis> {
  const effectiveCategories = anamnesisCatalog.list();
  const systemPrompt = buildPrompt(
    section(
      "Role",
      `You are an AI generating data for a medical training simulator.
Your current task is to render the Anamnesis (medical history) facts from the provided Case Outline in the patient's own voice. The outline is the single source of truth — you do not decide any clinical facts yourself.`
    ),

    section(
      "Requirements",
      `- The text inside the JSON must be written from the perspective of the PATIENT filling out an intake form.
- Use the patient's subjective voice, layman's terms, and personal tone (e.g., "My chest feels heavy" instead of "Patient presents with angina").
- Adapt the tone to fit the patient's age and demographic as defined in the outline.
- Fill exactly the required intake form categories, using their exact names.
- Use ONLY the facts specified in the outline. Do not invent symptoms, history items, medications, or details beyond the outline; your job is voice and format.
- Return ONLY the JSON object, no additional text like prefix or suffix.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(z.object({ anamnesis: buildAnamnesisSchema() }))}`
    )
  );

  const userPrompt = buildPrompt(
    section("Target diagnosis", `${diagnosis.name} ${diagnosis.icd ?? ""}`),

    section("Case outline", outline),

    section(
      "Required intake form categories to fill",
      effectiveCategories
        ? effectiveCategories.join(", ")
        : `Use standard patient intake categories (e.g., Current Symptoms, Past Illnesses, Family History, Lifestyle/Habits, Current Medications).`
    ),

    section("Additional instructions", userInstructions)
  );

  console.debug(
    `[GenerateAnamnesisFromOutline] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  // Initialize cases to empty in case of failure
  try {
    const AnamnesisSchemaWrapper = z.object({
      anamnesis: buildAnamnesisSchema(effectiveCategories),
    });

    const anamnesis: Anamnesis = await retry(
      async (attempt: number, previousError?: Error) => {
        const result = await getCreativeLLM(context?.llmConfig)
          .withStructuredOutput(AnamnesisSchemaWrapper)
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
            context?.signal !== undefined
              ? { signal: context.signal }
              : undefined
          )
          .catch((error) => {
            handleLangchainError(error);
          });

        console.debug(
          `[GenerateAnamnesisFromOutline] [Attempt ${attempt}] LLM raw Response:\n`,
          JSON.stringify(result, null, 2)
        );

        return result.anamnesis;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateAnamnesisFromOutline] Attempt ${attempt} failed with error: ${error.message}`;
        console.error(msg);
        bus.emit("Generation Log", {
          msg,
          logLevel: "error",
          timestamp: new Date().toISOString(),
        });
      }
    );

    return anamnesis;
  } catch (error) {
    console.error(`[GenerateAnamnesisFromOutline] Error:`, error);
    throw error;
  }
}

/**
 * Generates translations of anamnesis categories from English to a target language using an LLM.
 * @param englishCategories the anamnesis categories in English to translate
 * @param language the target language to translate the categories into
 * @returns a record mapping English categories to their translations in the target language
 */
export async function generateAnamnesisCategoriesFromEnglish(
  englishCategories: AnamnesisCategory[],
  language: Language,
  context?: RequestContext
): Promise<Record<AnamnesisCategory, AnamnesisCategory>> {
  return translateTermsKeyed({
    logTag: "GenerateAnamnesisCategoriesFromEnglish",
    taskDescription: `Translate the provided anamnesis categories from English to a target language.`,
    contextLines: [`Target language: ${language}`],
    terms: englishCategories,
    context,
  });
}
