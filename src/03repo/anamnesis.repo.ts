import { type AnamnesisCategory } from "@/models/Anamnesis.js";
import type { Language } from "@/models/Language.js";
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
 * Record<Language, Record<AnamnesisCategoryEnglish, AnamnesisCategoryTranslation>>
 */

// Preload translations from `src/data/anamnesisCategoriesTranslations.yml` if present and `js-yaml` is available.
function preloadAnamnesisCategoryTranslations(): LanguageAnamnesisCategoryMapping {
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
    const parsed = LanguageAnamnesisCategoryMappingSchema.safeParse(
      YAML.parse(fs.readFileSync(dataPath, "utf-8"))
    );
    if (!parsed.success) {
      console.warn(
        "[Anamnesis Service] Parsed YAML is not an object, skipping preload."
      );
      return {};
    }

    console.info(
      `[Anamnesis Service] Preloaded ${Object.keys(parsed.data).length} anamnesis categories translations from YAML.`
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
  preloadAnamnesisCategoryTranslations();

/**
 * Get the translation of an anamnesis category to English
 * @param category
 * @param language
 * @returns
 */
export function getAnamnesisCategoryTranslationToEnglish(
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
export function getAnamnesisCategoryTranslationFromEnglish(
  category: AnamnesisCategory,
  language: Language
): AnamnesisCategory | undefined {
  return AnamnesisCategoryFromEnglish[language]?.[category];
}

/**
 * Save new anamnesis category translations to the in-memory mapping
 * @param englishToTarget a record mapping English categories to their translations in the target language
 * @param language the target language of the provided translations
 */
export function saveAnamnesisCategoryTranslations(
  englishToTarget: Record<AnamnesisCategory, AnamnesisCategory>,
  language: Language
) {
  if (!AnamnesisCategoryFromEnglish[language]) {
    AnamnesisCategoryFromEnglish[language] = {};
  }

  Object.assign(AnamnesisCategoryFromEnglish[language], englishToTarget);
}
