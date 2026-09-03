import { z } from "zod/v4";
import { asc, eq } from "drizzle-orm";
import { chunk, db, syncSource } from "./db.js";
import { predefinedItem } from "./schema.js";
import { resolvePredefinedList } from "./predefinedList.js";
import {
  type AnamnesisCategory,
  AnamnesisCategorySchema,
} from "../models/Anamnesis.js";
import { type ForeignLanguage } from "../models/Language.js";
import { createTranslationStore } from "./translationStore.js";
import { catalogFile } from "./paths.js";

/** Exposed for the startup catalogue validator (`catalog/startupValidation.ts`). */
export const ANAMNESIS_TRANSLATIONS_FILE = catalogFile(
  "anamnesisCategoriesTranslations.yml"
);

/**
 * Anamnesis category translations.
 * Record<Language, Record<AnamnesisCategoryEnglish, AnamnesisCategoryTranslation>>
 */
const store = createTranslationStore({
  name: "Anamnesis",
  yamlFile: ANAMNESIS_TRANSLATIONS_FILE,
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
    catalogFile("anamnesisCategories.yml"),
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
      "[Anamnesis] anamnesisCategories.yml unchanged, skipped YAML parse."
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
  });

/**
 * Resolve the effective anamnesis category list.
 *
 * - If a static default list is configured (Rules 2 & 3) it is returned.
 * - Otherwise `undefined` is returned and the LLM may invent categories freely.
 */
export function getEffectiveCategoryList(): AnamnesisCategory[] | undefined {
  return AnamnesisCategoryDefaults;
}
