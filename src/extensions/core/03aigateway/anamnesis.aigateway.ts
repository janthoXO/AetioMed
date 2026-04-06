import {
  AnamnesisCategoryDefaults,
  AnamnesisJsonExample,
  AnamnesisSchema,
  type Anamnesis,
  type AnamnesisCategory,
} from "../models/Anamnesis.js";
import { bus } from "@/extensions/core/index.js";
import type { Language } from "../models/Language.js";
import {
  buildPrompt,
  getCreativeLLM,
  getDeterministicLLM,
  handleLangchainError,
} from "../utils/llm.js";
import z from "zod";
import type { Diagnosis } from "../models/Diagnosis.js";
import { HumanMessage, SystemMessage } from "langchain";
import { retry } from "../utils/retry.js";
import type { RequestContext } from "../utils/context.js";
import type { Symptom } from "../models/Symptom.js";
import type { Case } from "../models/Case.js";
import type { Inconsistency } from "../models/Inconsistency.js";

export async function generateAnamnesisCoT(
  diagnosis: Diagnosis,
  symptoms: Symptom[],
  userInstructions?: string,
  anamnesisCategories:
    | AnamnesisCategory[]
    | undefined = AnamnesisCategoryDefaults,
  context?: RequestContext
): Promise<string> {
  const systemPrompt = buildPrompt(
    `You are an expert medical educator specializing in designing realistic clinical mock cases for medical students. 
Your task is to generate a step-by-step logical reasoning process (Chain of Thought) detailing EXACTLY HOW to construct the Anamnesis (medical history)`,

    `The following symptoms are typical for the diagnosis. You may use a subset of them:
${symptoms.map((s, idx) => `${idx + 1}. ${s.name}: ${s.description ?? ""}`).join("\n")}`,

    `Instructions:
1. The anamnesis data will be written from the perspective of the PATIENT filling out an intake form.
2. DO NOT generate the actual anamnesis data yet. Only generate the thinking process which should be specific to the given diagnosis and a subset of symptoms.
3. Outline a sequential thought process.
4. Output ONLY the numbered reasoning steps, without any conversational filler.`
  );

  const userPrompt = buildPrompt(
    `Target Diagnosis: ${diagnosis.name} ${diagnosis.icd ?? ""}`,

    userInstructions
      ? `Additional Instructions: ${userInstructions}`
      : undefined,

    anamnesisCategories
      ? `Required Intake Form Categories to fill: ${anamnesisCategories.join(", ")}`
      : `Use standard patient intake categories (e.g., Current Symptoms, Past Illnesses, Family History, Lifestyle/Habits, Current Medications).`
  );

  console.debug(
    `[GenerateAnamnesisCoT] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const stepsString: string = await retry(
      async (attempt: number) => {
        const text = await getDeterministicLLM({
          ...context?.llmConfig,
          outputFormat: "text",
        })
          .invoke([
            new SystemMessage(systemPrompt),
            new HumanMessage(userPrompt),
          ])
          .catch((error) => {
            handleLangchainError(error);
          });
        console.debug(
          `[GenerateAnamnesisCoT] [Attempt ${attempt}] LLM raw Response:\n`,
          text.text
        );

        return text.text;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateAnamnesisCoT] Attempt ${attempt} failed with error: ${error.message}`;
        console.error(msg);
        bus.emit("Generation Log", {
          msg,
          logLevel: "error",
          timestamp: new Date().toISOString(),
        });
      }
    );

    return stepsString;
  } catch (error) {
    console.error(`[GenerateAnamnesisCoT] Error:`, error);
    throw error;
  }
}

export async function generateAnamnesis(
  diagnosis: Diagnosis, // provided by the user
  config:
    | {
        cot: string;
        symptoms: Symptom[];
      }
    | {
        outline: string;
      }
    | {
        case: Case;
        inconsistencies: Inconsistency[];
      },
  userInstructions?: string, // provided by the user
  anamnesisCategories:
    | AnamnesisCategory[]
    | undefined = AnamnesisCategoryDefaults, // provided by the user
  context?: RequestContext
): Promise<Anamnesis> {
  const systemPrompt = buildPrompt(
    `You are an AI generating data for a medical training simulator.
Your current task is to generate the Anamnesis (medical history) ${"outline" in config ? "based on the provided Case Outline" : ""}.`,

    "cot" in config
      ? `The following symptoms are typical for the diagnosis. You may use a subset of them:
      ${config.symptoms.map((s, idx) => `${idx + 1}. ${s.name}: ${s.description ?? ""}`).join("\n")}

Think step by step:
    ${config.cot}`
      : undefined,

    "outline" in config
      ? `Generate the anamnesis from scratch based on the approved outline with the given categories.`
      : undefined,

    "inconsistencies" in config
      ? `The previous JSON generation contained inconsistencies. Regenerate the JSON, fixing the following issues while maintaining the patient's voice:

Original Anamnesis:
${JSON.stringify({ anamnesis: config.case.anamnesis })}

Inconsistencies to Fix:
${config.inconsistencies.map((i, idx) => `${idx + 1}. [Severity ${i.severity}] ${i.description}\n   Suggested Fix: ${i.suggestion}`).join("\n")}`
      : undefined,

    `Return ONLY a valid JSON object matching the requested categories.
Schema:
${JSON.stringify({ anamnesis: AnamnesisJsonExample() })}`,

    `Requirements:
- The text inside the JSON must be written from the perspective of the PATIENT filling out an intake form.
- Use the patient's subjective voice, layman's terms, and personal tone (e.g., "My chest feels heavy" instead of "Patient presents with angina").
- Adapt the tone to fit the patient's age and demographic as defined in the outline.
- Return ONLY the JSON object, no additional text like prefix or suffix.`
  );

  const userPrompt = buildPrompt(
    `Target Diagnosis: ${diagnosis.name} ${diagnosis.icd ?? ""}`,

    "outline" in config ? `Case Outline: ${config.outline}` : undefined,

    anamnesisCategories
      ? `Required Intake Form Categories to fill: ${anamnesisCategories.join(", ")}`
      : `Use standard patient intake categories (e.g., Current Symptoms, Past Illnesses, Family History, Lifestyle/Habits, Current Medications).`,

    userInstructions
      ? `Additional Instructions: ${userInstructions}`
      : undefined
  );

  console.debug(
    `[GenerateAnamnesisFromOutline] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  // Initialize cases to empty in case of failure
  try {
    const AnamnesisSchemaWrapper = z.object({
      anamnesis: AnamnesisSchema.describe("Generated anamnesis"),
    });

    const anamnesis: Anamnesis = await retry(
      async (attempt: number, previousError?: Error) => {
        const result = await getCreativeLLM(context?.llmConfig)
          .withStructuredOutput(AnamnesisSchemaWrapper)
          .invoke([
            new SystemMessage(systemPrompt),
            new HumanMessage(
              userPrompt +
                (previousError
                  ? `\nPrevious generation error: ${previousError.message}`
                  : "")
            ),
          ])
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
 * Translates anamnesis categories from a provided language to English, using a combination of repository lookups and LLM generation for missing translations.
 * @param categories the anamnesis categories to translate to English
 * @param language the source language of the provided categories
 * @returns a record mapping the provided categories to their English translations
 */
export async function generateAnamnesisCategoriesToEnglish(
  categories: AnamnesisCategory[],
  language: Language,
  context?: RequestContext
): Promise<Record<AnamnesisCategory, AnamnesisCategory>> {
  const systemPrompt = `Translate the provided anamnesis categories from the provided language to English:

Return the categories mapped to their translated part in a JSON
{
  "provided category1": "translated category1",
  "provided category2": "translated category2",
  ...
}`;

  const userPrompt = `Source language: ${language}
Categories to translate:
${categories.join("\n")}`;

  console.debug(
    `[GenerateAnamnesisCategoriesToEnglish] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  const prompt = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const response = await getDeterministicLLM(context?.llmConfig).invoke(prompt);

  console.debug(
    `[GenerateAnamnesisCategoriesToEnglish] Generated anamnesis category translations:\n${response.text}`
  );

  const responseSchema = z.record(z.string(), z.string());
  const parsed = responseSchema.parse(JSON.parse(response.text));

  // Filter only the requested categories
  const result: Record<AnamnesisCategory, AnamnesisCategory> = {};
  for (const [original, translated] of Object.entries(parsed)) {
    if (categories.includes(original as AnamnesisCategory)) {
      result[original as AnamnesisCategory] = translated as AnamnesisCategory;
    }
  }

  if (Object.keys(result).length !== categories.length) {
    throw new Error(
      "Not all categories were translated successfully to English."
    );
  }

  return result;
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
  const systemPrompt = buildPrompt(
    `Translate the provided anamnesis categories from English to a target language:`,

    `Return the categories mapped to their translated part in a JSON
{ "translations": 
  [
  "translated category1",
  "translated category2",
  ...
  ]
}`
  );

  const userPrompt = buildPrompt(
    `Target language: ${language}`,
    `Categories to translate:
${englishCategories.join("\n")}`
  );

  console.debug(
    `[GenerateAnamnesisCategoriesFromEnglish] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  return retry(
    async (attempt: number, previousError?: Error) => {
      const response = await getDeterministicLLM(context?.llmConfig)
        .withStructuredOutput(z.object({ translations: z.array(z.string()) }))
        .invoke([
          new SystemMessage(systemPrompt),
          new HumanMessage(
            userPrompt +
              (previousError
                ? `\nPrevious generation error: ${previousError.message}`
                : "")
          ),
        ]);

      console.debug(
        `[GenerateAnamnesisCategoriesFromEnglish] [Attempt ${attempt}] Generated anamnesis category translations:`,
        response
      );

      if (response.translations.length !== englishCategories.length) {
        throw new Error(
          `The number of translated categories does not match the number of English categories. Expected ${englishCategories.length} but got ${response.translations.length}.`
        );
      }

      const result: Record<string, string> = {};
      englishCategories.forEach((engCat, idx) => {
        result[engCat] = response.translations[idx]!;
      });

      return result;
    },
    2,
    0,
    (error, attempt) => {
      const msg = `[GenerateAnamnesisCategoriesFromEnglish] [Attempt ${attempt}] failed with error: ${error.message}`;
      console.error(msg);
      bus.emit("Generation Log", {
        msg,
        logLevel: "error",
        timestamp: new Date().toISOString(),
      });
    }
  );
}
