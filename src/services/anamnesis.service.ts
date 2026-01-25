import type { AnamnesisCategory } from "@/domain-models/Anamnesis.js";
import type { Language } from "@/domain-models/Language.js";
import { getDeterministicLLM } from "@/graph/llm.js";
import z from "zod";
import YAML from "yaml";
import fs from "fs";

const LanguageAnamnesisCategoryMappingSchema = z.partialRecord(
  z.enum(["English", "German"]),
  z.record(z.string(), z.string())
);

type LanguageAnamnesisCategoryMapping = z.infer<
  typeof LanguageAnamnesisCategoryMappingSchema
>;

/**
 * Record<Language, Record<AnamnesisCategoryTranslation, AnamnesisCategoryEnglish>>
 */

// Preload translations from `src/data/anamnesisCategories.yml` if present and `js-yaml` is available.
function preloadAnamnesisCategories(): LanguageAnamnesisCategoryMapping {
  const dataPath = new URL("../data/anamnesisCategories.yml", import.meta.url)
    .pathname;

  if (!fs.existsSync(dataPath)) {
    console.warn(
      "[Anamnesis Service] No anamnesisCategories.yml found, skipping preload."
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
      "[Anamnesis Service] Preloaded anamnesis categories from YAML."
    );
    return parsed.data;
  } catch (err) {
    console.warn(
      "[Anamnesis Service] Failed to preload anamnesis categories:",
      err
    );
    return {};
  }
}

const AnamnesisCategoryToEnglish: LanguageAnamnesisCategoryMapping =
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
  return AnamnesisCategoryToEnglish[language]?.[category];
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
  const translations = AnamnesisCategoryToEnglish[language];
  if (!translations) return undefined;

  for (const [translatedCategory, engCategory] of Object.entries(
    translations
  )) {
    if (engCategory === category) {
      return translatedCategory as AnamnesisCategory;
    }
  }

  return undefined;
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

    if (!AnamnesisCategoryToEnglish[language]) {
      AnamnesisCategoryToEnglish[language] = {};
    }
    Object.assign(AnamnesisCategoryToEnglish[language], generatedTranslations);
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

    if (!AnamnesisCategoryToEnglish[language]) {
      AnamnesisCategoryToEnglish[language] = {};
    }
    Object.assign(
      AnamnesisCategoryToEnglish[language],
      Object.fromEntries(
        Object.entries(generatedTranslations).map(([eng, translated]) => [
          translated,
          eng,
        ])
      )
    );
  }

  return translations;
}
