import { z } from "zod/v4";
import { asc, eq } from "drizzle-orm";
import { chunk, db, syncSource } from "../03repo/db.js";
import { predefinedItem } from "../03repo/schema.js";
import {
  readDeclaredEnglishKeys,
  resolvePredefinedList,
} from "../03repo/predefinedList.js";
import { getAnamnesisCategoryListForLanguage } from "../03repo/anamnesis.repo.js";
import type { Language } from "./Language.js";

export const AnamnesisCategorySchema = z.string();

export type AnamnesisCategory = z.infer<typeof AnamnesisCategorySchema>;

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

export const AnamnesisFieldSchema = z.object({
  category: AnamnesisCategorySchema.describe("Category of the anamnesis field"),
  answer: z.string().describe("Patient's response or clinical finding"),
});

export type AnamnesisField = z.infer<typeof AnamnesisFieldSchema>;

/**
 * Zod schema for the complete anamnesis array
 */
export const AnamnesisSchema = z
  .array(AnamnesisFieldSchema)
  .describe("Medical history collected from patient");

export type Anamnesis = z.infer<typeof AnamnesisSchema>;

export function buildAnamnesisFieldSchema(categories?: AnamnesisCategory[]) {
  if (categories?.length) {
    return AnamnesisFieldSchema.extend({
      category: z
        .literal(categories)
        .describe("Category of the anamnesis field"),
    });
  }
  return AnamnesisFieldSchema;
}

export function buildAnamnesisSchema(categories?: AnamnesisCategory[]) {
  return z
    .array(buildAnamnesisFieldSchema(categories))
    .describe("Medical history collected from patient");
}

export function AnamnesisJsonExample(): Anamnesis {
  return [
    {
      category: "category1",
      answer: "The patient's response or clinical finding",
    },
    {
      category: "category2",
      answer: "The patient's response or clinical finding",
    },
  ];
}

export function AnamnesisJsonExampleString(): string {
  return JSON.stringify(AnamnesisJsonExample(), null, 2);
}
