import { z } from "zod/v4";
import { asc, eq } from "drizzle-orm";
import { chunk, db, syncSource } from "./db.js";
import { predefinedItem } from "./schema.js";
import {
  readDeclaredEnglishKeys,
  resolvePredefinedList,
} from "./predefinedList.js";
import {
  type AnamnesisCategory,
  AnamnesisCategorySchema,
} from "../models/Anamnesis.js";
import { type ForeignLanguage, type Language } from "../models/Language.js";
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

const SOURCE = "anamnesisCategories";

function syncAnamnesisCategoryDefaults() {
  const synced = syncSource(
    SOURCE,
    "data/anamnesisCategories.yml",
    (parsed) => {
      const categoryObject = z
        .object({
          categories: z.array(AnamnesisCategorySchema),
        })
        .safeParse(parsed);

      if (!categoryObject.success) {
        console.error(
          "[Anamnesis] Failed to load default categories from YAML"
        );
        return;
      }

      // Plain read-only ordered list (no runtime additions) - full replace.
      db.delete(predefinedItem).where(eq(predefinedItem.source, SOURCE)).run();

      const rows = categoryObject.data.categories.map((value, position) => ({
        source: SOURCE,
        position,
        value,
      }));
      for (const batch of chunk(rows)) {
        db.insert(predefinedItem).values(batch).run();
      }

      console.info(
        `[Anamnesis] Synced ${categoryObject.data.categories.length} default categories from YAML`
      );
    }
  );

  if (!synced) {
    console.info(
      "[Anamnesis] data/anamnesisCategories.yml unchanged, skipped YAML parse."
    );
  }
}

function loadAnamnesisCategoryDefaults(): AnamnesisCategory[] | undefined {
  const rows = db
    .select({ value: predefinedItem.value })
    .from(predefinedItem)
    .where(eq(predefinedItem.source, SOURCE))
    .orderBy(asc(predefinedItem.position))
    .all();
  return rows.length ? rows.map((row) => row.value) : undefined;
}

syncAnamnesisCategoryDefaults();

export const AnamnesisCategoryDefaults: AnamnesisCategory[] | undefined =
  resolvePredefinedList({
    defaults: loadAnamnesisCategoryDefaults(),
    translationKeys: readDeclaredEnglishKeys(
      "data/anamnesisCategoriesTranslations.yml"
    ),
    label: "anamnesisCategories",
  });

/**
 * Resolve the effective anamnesis category list for a given generation language.
 *
 * - If a static default list is configured (Rules 2 & 3) it is always returned
 *   regardless of language.
 * - If no defaults are configured but translation mappings exist for the given
 *   non-English language (Rule 4), the English keys for that language are
 *   returned so the from-English output translator can always resolve them.
 * - Otherwise `undefined` is returned and the LLM may invent categories freely.
 */
export function getEffectiveCategoryList(
  language?: Language
): AnamnesisCategory[] | undefined {
  if (AnamnesisCategoryDefaults !== undefined) {
    return AnamnesisCategoryDefaults;
  }
  if (language && language !== "English") {
    const keys = getAnamnesisCategoryListForLanguage(language);
    return keys.length > 0 ? keys : undefined;
  }
  return undefined;
}
