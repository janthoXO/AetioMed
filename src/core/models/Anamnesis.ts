import { z } from "zod/v4";
import fs from "node:fs";
import YAML from "yaml";
import path from "node:path";

export const AnamnesisCategorySchema = z.string();

export type AnamnesisCategory = z.infer<typeof AnamnesisCategorySchema>;

function preloadAnamnesisCategoryDefaults(): AnamnesisCategory[] | undefined {
  const filepath = path.resolve(process.cwd(), "data/anamnesisCategories.yml");

  const categoryObject = z
    .object({
      categories: z.array(AnamnesisCategorySchema),
    })
    .safeParse(YAML.parse(fs.readFileSync(filepath, "utf-8")));

  if (!categoryObject.success) {
    console.error("[Anamnesis] Failed to load default categories from YAML");
    return undefined;
  }

  console.info(
    `[Anamnesis] Loaded ${categoryObject.data.categories.length} default categories from YAML:`
  );
  return categoryObject.data.categories;
}

export const AnamnesisCategoryDefaults: AnamnesisCategory[] | undefined =
  preloadAnamnesisCategoryDefaults();

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
