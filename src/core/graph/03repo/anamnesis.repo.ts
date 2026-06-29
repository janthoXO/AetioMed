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
 * Get the translation of an anamnesis category from English to the target language.
 */
export function getAnamnesisCategoryTranslationFromEnglish(
  category: AnamnesisCategory,
  language: ForeignLanguage
): AnamnesisCategory | undefined {
  return store.getFromEnglish(category, language);
}

/**
 * Return all English category keys that have a known translation for the given
 * target language. Used when no static default list is configured (Rule 4): the
 * English keys for a specific language define the generation constraint so the
 * from-English output translator can always resolve them.
 */
export function getAnamnesisCategoryListForLanguage(
  language: ForeignLanguage
): AnamnesisCategory[] {
  return store.getAllEnglishKeysForLanguage(language);
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
