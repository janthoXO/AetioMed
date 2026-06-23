import { type AnamnesisCategory } from "../models/Anamnesis.js";
import { type ForeignLanguage } from "../models/Language.js";
import { createTranslationStore } from "./translationStore.js";

/**
 * Anamnesis category translations.
 * Record<Language, Record<AnamnesisCategoryEnglish, AnamnesisCategoryTranslation>>
 */
const store = createTranslationStore({
  name: "Anamnesis",
  yamlFile: "data/anamnesisCategoriesTranslations.yml",
});

/**
 * Get the translation of an anamnesis category to English (reverse lookup).
 */
export function getAnamnesisCategoryTranslationToEnglish(
  category: AnamnesisCategory,
  language: ForeignLanguage
): AnamnesisCategory | undefined {
  return store.getToEnglish(category, language);
}

/**
 * Get the translation of an anamnesis category from English to the target language.
 */
export function getAnamnesisCategoryTranslationFromEnglish(
  category: AnamnesisCategory,
  language: ForeignLanguage
): AnamnesisCategory | undefined {
  return store.getFromEnglish(category, language);
}

/**
 * Save new anamnesis category translations to the in-memory mapping.
 * @param englishToTarget a record mapping English categories to their translations in the target language
 */
export function saveAnamnesisCategoryTranslations(
  englishToTarget: Record<AnamnesisCategory, AnamnesisCategory>,
  language: ForeignLanguage
) {
  store.save(englishToTarget, language);
}
