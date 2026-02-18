import { z } from "zod/v4";
import fs from "node:fs";
import YAML from "yaml";
import path from "node:path";

export const AnamnesisCategorySchema = z.string();

export type AnamnesisCategory = z.infer<typeof AnamnesisCategorySchema>;

function preloadAnamnesisCategoryDefaults(): AnamnesisCategory[] | undefined {
  const filepath = path.resolve(
    import.meta.dirname,
    "../data/anamnesisCategories.yml"
  );

  const categoryObject = YAML.parse(fs.readFileSync(filepath, "utf-8")) as
    | {
        categories: AnamnesisCategory[];
      }
    | undefined;

  console.info(
    "[Anamnesis] Loaded default categories from YAML:",
    categoryObject?.categories
  );
  return categoryObject?.categories;
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

export function AnamnesisDescriptionPrompt(): string {
  return "Anamnesis: Medical history with multiple categories";
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
