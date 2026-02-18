import {
  AnamnesisCategoryDefaults,
  AnamnesisJsonExample,
  AnamnesisSchema,
  type Anamnesis,
  type AnamnesisCategory,
} from "@/02domain-models/Anamnesis.js";
import type { Language } from "@/02domain-models/Language.js";
import {
  getCreativeLLM,
  getDeterministicLLM,
  handleLangchainError,
  parseStructuredResponseAgent,
} from "@/02ai/llm.js";
import z from "zod";
import YAML from "yaml";
import fs from "fs";
import type { Inconsistency } from "@/02domain-models/Inconsistency.js";
import type { Diagnosis } from "@/02domain-models/Diagnosis.js";
import type { Symptom } from "@/02domain-models/Symptom.js";
import {
  createAgent,
  HumanMessage,
  providerStrategy,
  SystemMessage,
} from "langchain";
import { retry } from "@/utils/retry.js";
import type { Case } from "@/02domain-models/Case.js";

const LanguageAnamnesisCategoryMappingSchema = z.partialRecord(
  z.enum(["English", "German"]),
  z.record(z.string(), z.string())
);

type LanguageAnamnesisCategoryMapping = z.infer<
  typeof LanguageAnamnesisCategoryMappingSchema
>;

/**
 * Record<Language, Record<AnamnesisCategoryEnglish, AnamnesisCategoryTranslation>>
 */

// Preload translations from `src/data/anamnesisCategoriesTranslations.yml` if present and `js-yaml` is available.
function preloadAnamnesisCategories(): LanguageAnamnesisCategoryMapping {
  const dataPath = new URL(
    "../data/anamnesisCategoriesTranslations.yml",
    import.meta.url
  ).pathname;

  if (!fs.existsSync(dataPath)) {
    console.warn(
      "[Anamnesis Service] No anamnesisCategoriesTranslations.yml found, skipping preload."
    );
    return {};
  }

  try {
    const fileContents = fs.readFileSync(dataPath, "utf-8");
    const parsed = LanguageAnamnesisCategoryMappingSchema.safeParse(
      YAML.parse(fileContents)
    );
    if (!parsed.success) {
      console.warn(
        "[Anamnesis Service] Parsed YAML is not an object, skipping preload.",
        parsed.error
      );
      return {};
    }

    console.info(
      "[Anamnesis Service] Preloaded anamnesis categories translations from YAML.",
      parsed.data
    );
    return parsed.data;
  } catch (err) {
    console.warn(
      "[Anamnesis Service] Failed to preload anamnesis categories translations:",
      err
    );
    return {};
  }
}

const AnamnesisCategoryFromEnglish: LanguageAnamnesisCategoryMapping =
  preloadAnamnesisCategories();

/**
 * Get the translation of an anamnesis category to English
 * @param category
 * @param language
 * @returns
 */
function getAnamnesisCategoryTranslationToEnglish(
  category: AnamnesisCategory,
  language: Language
): AnamnesisCategory | undefined {
  const translations = AnamnesisCategoryFromEnglish[language];
  if (!translations) return undefined;

  for (const [engCategory, translatedCategory] of Object.entries(
    translations
  )) {
    if (translatedCategory === category) {
      return engCategory as AnamnesisCategory;
    }
  }

  return undefined;
}

/**
 * Get the translation of an anamnesis category from English to the target language
 * @param category
 * @param language
 * @returns
 */
function getAnamnesisCategoryTranslationFromEnglish(
  category: AnamnesisCategory,
  language: Language
): AnamnesisCategory | undefined {
  return AnamnesisCategoryFromEnglish[language]?.[category];
}

async function generateAnamnesisCategoriesToEnglish(
  categories: AnamnesisCategory[],
  language: Language
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
    `[Anamnesis Service] Generating anamnesis category translations with prompt: 
${systemPrompt}
${userPrompt}`
  );

  const prompt = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const response = await getDeterministicLLM().invoke(prompt);

  console.debug(
    "[Anamnesis Service] Generated anamnesis category translations:",
    response.text
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

async function generateAnamnesisCategoriesFromEnglish(
  categories: AnamnesisCategory[],
  language: Language
): Promise<Record<AnamnesisCategory, AnamnesisCategory>> {
  const systemPrompt = `Translate the provided anamnesis categories from English to a target language:

Return the categories mapped to their translated part in a JSON
{
  "provided category1": "translated category1",
  "provided category2": "translated category2",
  ...
}`;

  const userPrompt = `Target language: ${language}
Categories to translate:
${categories.join("\n")}`;

  console.debug(
    `[Anamnesis Service] Generating anamnesis category translations with prompt: 
${systemPrompt}
${userPrompt}`
  );

  const prompt = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const response = await getDeterministicLLM().invoke(prompt);

  console.debug(
    "[Anamnesis Service] Generated anamnesis category translations:",
    response.text
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
      `Not all categories were translated successfully to ${language}.`
    );
  }

  return result;
}

export async function translateAnamnesisCategoriesToEnglish(
  categories: AnamnesisCategory[],
  language: Language
): Promise<Record<AnamnesisCategory, AnamnesisCategory>> {
  const translations: Record<AnamnesisCategory, AnamnesisCategory> = {};
  const failedTranslations: AnamnesisCategory[] = [];
  for (const category of categories) {
    const translatedCategory = getAnamnesisCategoryTranslationToEnglish(
      category,
      language
    );

    if (translatedCategory) {
      translations[category] = translatedCategory;
    } else {
      failedTranslations.push(category);
    }
  }

  if (failedTranslations.length > 0) {
    const generatedTranslations = await generateAnamnesisCategoriesToEnglish(
      failedTranslations,
      language
    );

    Object.assign(translations, generatedTranslations);

    if (!AnamnesisCategoryFromEnglish[language]) {
      AnamnesisCategoryFromEnglish[language] = {};
    }
    Object.assign(
      AnamnesisCategoryFromEnglish[language],
      Object.fromEntries(
        Object.entries(generatedTranslations).map(([translated, eng]) => [
          eng,
          translated,
        ])
      )
    );
  }

  return translations;
}

export async function translateAnamnesisCategoriesFromEnglish(
  categories: AnamnesisCategory[],
  language: Language
): Promise<Record<AnamnesisCategory, AnamnesisCategory>> {
  const translations: Record<AnamnesisCategory, AnamnesisCategory> = {};
  const failedTranslations: AnamnesisCategory[] = [];
  for (const category of categories) {
    const translatedCategory = getAnamnesisCategoryTranslationFromEnglish(
      category,
      language
    );

    if (translatedCategory) {
      translations[category] = translatedCategory;
    } else {
      failedTranslations.push(category);
    }
  }

  if (failedTranslations.length > 0) {
    const generatedTranslations = await generateAnamnesisCategoriesFromEnglish(
      failedTranslations,
      language
    );

    Object.assign(translations, generatedTranslations);

    if (!AnamnesisCategoryFromEnglish[language]) {
      AnamnesisCategoryFromEnglish[language] = {};
    }
    Object.assign(
      AnamnesisCategoryFromEnglish[language],
      generatedTranslations
    );
  }

  return translations;
}

export async function generateAnamnesisCoT(
  diagnosis: Diagnosis,
  symptoms: Symptom[],
  relatedCase?: Case,
  userInstructions?: string,
  anamnesisCategories:
    | AnamnesisCategory[]
    | undefined = AnamnesisCategoryDefaults
): Promise<string> {
  const systemPrompt = `You are a patient with these symptoms: 
${symptoms.map((s) => s.name).join(", ")}
Generate a step by step reasoning process ${anamnesisCategories ? "to answer the provided anamnesis categories." : "to generate an anamnesis."}
Return the steps as a list of steps in markdown format.
${
  relatedCase
    ? `The patient case has the following properties which might be relevant for the anamnesis generation:
  ${JSON.stringify(relatedCase)}`
    : ""
}`;

  const userPrompt = [
    `Provided Diagnosis: ${diagnosis.name} ${diagnosis.icd ?? ""}`,
    userInstructions
      ? `Additional provided instructions: ${userInstructions}`
      : "",
    anamnesisCategories
      ? `Provided anamnesis categories: ${anamnesisCategories.join(", ")}`
      : "",
  ]
    .filter((s) => s.length > 0)
    .join("\n");

  console.debug(
    `[GenerateAnamnesisCoT] Prompt:\n${systemPrompt}\n${userPrompt}`
  );

  try {
    const stepsString: string = await retry(
      async () => {
        const text = await getDeterministicLLM({ outputFormat: "text" })
          .invoke([
            new SystemMessage(systemPrompt),
            new HumanMessage(userPrompt),
          ])
          .catch((error) => {
            handleLangchainError(error);
          });
        console.debug("[GenerateAnamnesisCoT] LLM raw Response:\n", text);

        return text.text;
      },
      2,
      0
    );

    return stepsString;
  } catch (error) {
    console.error(`[GenerateAnamnesisCoT] Error:`, error);
    throw error;
  }
}

export async function generateAnamnesisOneShot(
  diagnosis: Diagnosis, // provided by the user
  symptoms: Symptom[], // generate by a chain step
  relatedCase?: Case, // generated by a previous chain step
  cot?: string, // generated by a previous chain step
  userInstructions?: string, // provided by the user
  anamnesisCategories:
    | AnamnesisCategory[]
    | undefined = AnamnesisCategoryDefaults, // provided by the user
  inconsistencies?: Inconsistency[] // generated by a previous chain step
): Promise<Anamnesis> {
  const { anamnesis: previousAnamnesis, ...caseWithoutAnamnesis } =
    relatedCase ?? {};
  const systemPrompt = `You are a patient with these symptoms: 
${symptoms.map((s) => s.name).join(", ")}
Generate an anamnesis ${anamnesisCategories ? "answering the provided categories based on your symptoms." : "answering standard anamnesis categories."}
${cot ? `Think step by step:\n${cot}` : ""}
${
  Object.keys(caseWithoutAnamnesis).length > 0
    ? `The patient case has the following properties which might be relevant for the anamnesis generation:
  ${JSON.stringify(caseWithoutAnamnesis)}`
    : ""
}
${
  previousAnamnesis
    ? `Try to fix the inconsistencies from the previous anamnesis generated:\n${JSON.stringify({ anamnesis: previousAnamnesis })}
with inconsistencies:
${inconsistencies
  ?.map((i, idx) => {
    return `${idx + 1}. severity ${i.severity}: ${i.description}
suggested fix: ${i.suggestion}`;
  })
  .join("\n")}`
    : ``
}
Return your response in JSON with the provided anamnesis categories
${JSON.stringify({ anamnesis: AnamnesisJsonExample() })}

Requirements:
- Be medically accurate and realistic
- Use standard medical terminology
- Return ONLY the JSON object, no additional text`;

  const userPrompt = [
    `Provided Diagnosis: ${diagnosis.name} ${diagnosis.icd ?? ""}`,
    userInstructions
      ? `Additional provided instructions: ${userInstructions}`
      : "",
    anamnesisCategories
      ? `Provided anamnesis categories: ${anamnesisCategories.join(", ")}`
      : "",
  ]
    .filter((s) => s.length > 0)
    .join("\n");

  console.debug(
    `[GenerateAnamnesisOneShot] Prompt:\n${systemPrompt}\n${userPrompt}`
  );

  // Initialize cases to empty in case of failure
  try {
    const AnamnesisSchemaWrapper = z.object({
      anamnesis: AnamnesisSchema.describe("Generated anamnesis"),
    });

    const anamnesis: Anamnesis = await retry(
      async () => {
        const result = await createAgent({
          model: getCreativeLLM(),
          tools: [],
          systemPrompt: systemPrompt,
          responseFormat: providerStrategy(AnamnesisSchemaWrapper),
        })
          .invoke({ messages: [new HumanMessage(userPrompt)] })
          .catch((error) => {
            handleLangchainError(error);
          });

        console.debug(
          "[GenerateAnamnesisOneShot] LLM raw Response:\ncontent:\n",
          result.messages[result.messages.length - 1]?.content,
          "\nstructured response:\n",
          result.structuredResponse
        );

        return parseStructuredResponseAgent(result, AnamnesisSchemaWrapper)
          .anamnesis;
      },
      2,
      0
    );

    return anamnesis;
  } catch (error) {
    console.error(`[GenerateAnamnesisOneShot] Error:`, error);
    throw error;
  }
}
