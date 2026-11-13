import { z } from "zod/v4";
import { asc, eq } from "drizzle-orm";
import type { DbHandle } from "../../persistence/db.js";
import { predefinedItem } from "../../persistence/schema.js";
import { resolvePredefinedList } from "../../persistence/predefinedList.js";
import {
  type AnamnesisCategory,
  AnamnesisCategorySchema,
} from "@/core/graph/shared/domain/Anamnesis.js";
import { type ForeignLanguage } from "@/core/graph/shared/domain/Language.js";
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
  /** Effective category list; `undefined` = freeform, LLM invents categories. */
  getEffectiveCategoryList(): AnamnesisCategory[] | undefined;
  /** Provider allow-list of a category (`{ name, providers }` entry); `undefined` = none named. */
  getCategoryProviders(category: AnamnesisCategory): string[] | undefined;
}

const SOURCE = "anamnesisCategories";
const PROVIDERS_SOURCE = "anamnesisCategoryProviders";

/** A YAML entry: a plain name, or a name with its provider allow-list. */
const EntrySchema = z.union([
  AnamnesisCategorySchema,
  z.object({
    name: AnamnesisCategorySchema,
    providers: z.array(z.string()),
  }),
]);

/**
 * Syncs `anamnesisCategories.yml` / `anamnesisCategoriesTranslations.yml` into
 * `dbHandle`, exposes category list and translation lookups. I/O here, not at import.
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
            categories: z.array(EntrySchema).default([]),
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

        const entries = categoryObject.data.categories.map((e) =>
          typeof e === "string" ? { name: e, providers: [] } : e
        );
        const rows = entries.map(({ name }, position) => ({
          source: SOURCE,
          position,
          value: name,
        }));
        for (const batch of dbHandle.chunk(rows)) {
          dbHandle.db.insert(predefinedItem).values(batch).run();
        }

        dbHandle.db
          .delete(predefinedItem)
          .where(eq(predefinedItem.source, PROVIDERS_SOURCE))
          .run();
        const providerRows = entries
          .filter((e) => e.providers.length)
          .map((e, position) => ({
            source: PROVIDERS_SOURCE,
            position,
            value: JSON.stringify({
              category: e.name,
              providers: e.providers,
            }),
          }));
        for (const batch of dbHandle.chunk(providerRows)) {
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

  const providersByCategory = new Map<string, string[]>();
  for (const row of dbHandle.db
    .select({ value: predefinedItem.value })
    .from(predefinedItem)
    .where(eq(predefinedItem.source, PROVIDERS_SOURCE))
    .all()) {
    const { category, providers } = JSON.parse(row.value) as {
      category: string;
      providers: string[];
    };
    providersByCategory.set(category, providers);
  }

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
    getCategoryProviders(category) {
      return providersByCategory.get(category);
    },
  };
}
