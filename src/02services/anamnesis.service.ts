import { getRequiredRequestContext } from "@/utils/context.js";

import { type AnamnesisCategory } from "@/models/Anamnesis.js";
import type { Language } from "@/models/Language.js";
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
      language,
      getRequiredRequestContext()
    );

    Object.assign(translations, generatedTranslations);

    saveAnamnesisCategoryTranslations(generatedTranslations, language);
  }

  return translations;
}
