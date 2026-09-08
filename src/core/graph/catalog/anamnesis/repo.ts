import { z } from "zod/v4";
import { asc, eq } from "drizzle-orm";
import type { DbHandle } from "../../persistence/db.js";
import { predefinedItem } from "../../persistence/schema.js";
import { resolvePredefinedList } from "../../persistence/predefinedList.js";
import {
  type AnamnesisCategory,
  AnamnesisCategorySchema,
} from "../../models/Anamnesis.js";
import { type ForeignLanguage } from "../../models/Language.js";
import { createTranslationStore } from "../../persistence/translationStore.js";
import { catalogFile } from "../../persistence/paths.js";

export interface AnamnesisRepo {
  /** Absolute path of the translations YAML, for the startup catalogue validator. */
  readonly translationsFile: string;
  /** Get the translation of an anamnesis category from English to the target language. */
  getAnamnesisCategoryTranslationFromEnglish(
    category: AnamnesisCategory,
    language: ForeignLanguage
  ): AnamnesisCategory | undefined;
  saveAnamnesisCategoryTranslations(
    englishToTarget: Record<AnamnesisCategory, AnamnesisCategory>,
    language: ForeignLanguage
  ): void;
  /**
   * Resolve the effective anamnesis category list.
   *
   * - If a static default list is configured (Rules 2 & 3) it is returned.
   * - Otherwise `undefined` is returned and the LLM may invent categories
   *   freely.
   */
  getEffectiveCategoryList(): AnamnesisCategory[] | undefined;
}

const SOURCE = "anamnesisCategories";

/**
 * Syncs `anamnesisCategories.yml` / `anamnesisCategoriesTranslations.yml`
 * (under `catalogDir`) into `dbHandle`'s embedded database, then exposes the
 * effective category list and translation lookups. All I/O happens here,
 * not at import time.
 */
export function createAnamnesisRepo(
  dbHandle: DbHandle,
  catalogDir: string
): AnamnesisRepo {
  const translationsFile = catalogFile(
    catalogDir,
    "anamnesisCategoriesTranslations.yml"
  );

  /**
   * Anamnesis category translations.
   * Record<Language, Record<AnamnesisCategoryEnglish, AnamnesisCategoryTranslation>>
   */
  const store = createTranslationStore(dbHandle, {
    name: "Anamnesis",
    yamlFile: translationsFile,
  });

  function syncAnamnesisCategoryDefaults() {
    const synced = dbHandle.syncSource(
      SOURCE,
      catalogFile(catalogDir, "anamnesisCategories.yml"),
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
        dbHandle.db
          .delete(predefinedItem)
          .where(eq(predefinedItem.source, SOURCE))
          .run();

        const rows = categoryObject.data.categories.map((value, position) => ({
          source: SOURCE,
          position,
          value,
        }));
        for (const batch of dbHandle.chunk(rows)) {
          dbHandle.db.insert(predefinedItem).values(batch).run();
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
    const rows = dbHandle.db
      .select({ value: predefinedItem.value })
      .from(predefinedItem)
      .where(eq(predefinedItem.source, SOURCE))
      .orderBy(asc(predefinedItem.position))
      .all();
    return rows.length ? rows.map((row) => row.value) : undefined;
  }

  syncAnamnesisCategoryDefaults();

  const anamnesisCategoryDefaults: AnamnesisCategory[] | undefined =
    resolvePredefinedList({
      defaults: loadAnamnesisCategoryDefaults(),
    });

  return {
    translationsFile,
    getAnamnesisCategoryTranslationFromEnglish(category, language) {
      return store.getFromEnglish(category, language);
    },
    saveAnamnesisCategoryTranslations(englishToTarget, language) {
      store.save(englishToTarget, language);
    },
    getEffectiveCategoryList() {
      return anamnesisCategoryDefaults;
    },
  };
}
