import { getRequiredRequestContext } from "@/utils/context.js";

import { type AnamnesisCategory } from "@/models/Anamnesis.js";
import type { ForeignLanguage } from "@/models/Language.js";
import {
  generateAnamnesisCategoriesFromEnglish,
  generateAnamnesisCategoriesToEnglish,
} from "@/03aigateway/anamnesis.aigateway.js";
import {
  getAnamnesisCategoryTranslationFromEnglish,
  getAnamnesisCategoryTranslationToEnglish,
  saveAnamnesisCategoryTranslations,
} from "@/03repo/anamnesis.repo.js";

export async function translateAnamnesisCategoriesToEnglish(
  categories: AnamnesisCategory[],
  language: ForeignLanguage
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
      language,
      getRequiredRequestContext()
    );

    Object.assign(translations, generatedTranslations);

    saveAnamnesisCategoryTranslations(
      Object.fromEntries(
        Object.entries(generatedTranslations).map(([translated, eng]) => [
          eng,
          translated,
        ])
      ),
      language
    );
  }

  return translations;
}

/**
 * Translates anamnesis categories from English to the specified language
 * @param categories in english to translate
 * @param language to translate to
 * @returns a record mapping english categories to translated categories
 */
export async function translateAnamnesisCategoriesFromEnglish(
  categories: AnamnesisCategory[],
  language: ForeignLanguage
): Promise<Record<AnamnesisCategory, AnamnesisCategory>> {
  const translations: Record<AnamnesisCategory, AnamnesisCategory> = {};
  const failedTranslations: AnamnesisCategory[] = [];

  // 1. Try to get translations from the repo
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

  // 2. For categories that are not in the repo, use the LLM to translate
  if (failedTranslations.length > 0) {
    const generatedTranslations = await generateAnamnesisCategoriesFromEnglish(
      failedTranslations,
      language,
      getRequiredRequestContext()
    );

    Object.assign(translations, generatedTranslations);

    // 2.2 Save the generated translations in the repo for future use
    saveAnamnesisCategoryTranslations(generatedTranslations, language);
  }

  return translations;
}
