import { z } from "zod/v4";
import { ContentPartsSchema } from "./ContentPart.js";

export const AnamnesisCategorySchema = z.string();

export type AnamnesisCategory = z.infer<typeof AnamnesisCategorySchema>;

/** Domain shape: answer as one or more content parts. See `ContentPart.ts`. */
export const AnamnesisFieldSchema = z.object({
  category: AnamnesisCategorySchema.describe("Category of the anamnesis field"),
  answer: ContentPartsSchema.describe(
    "Patient's response or clinical finding, as one or more content parts"
  ),
});

export type AnamnesisField = z.infer<typeof AnamnesisFieldSchema>;

export const AnamnesisSchema = z
  .array(AnamnesisFieldSchema)
  .describe("Medical history collected from patient");

export type Anamnesis = z.infer<typeof AnamnesisSchema>;

/** LLM-facing shape: plain `z.string()` answer, never bytes. Gateway wraps it into a `ContentPart`. */
const AnamnesisFieldTextSchema = z.object({
  category: AnamnesisCategorySchema.describe("Category of the anamnesis field"),
  answer: z.string().describe("Patient's response or clinical finding"),
});

export function buildAnamnesisFieldSchema(categories?: AnamnesisCategory[]) {
  if (categories?.length) {
    return AnamnesisFieldTextSchema.extend({
      category: z
        .literal(categories)
        .describe("Category of the anamnesis field"),
    });
  }
  return AnamnesisFieldTextSchema;
}

export function buildAnamnesisSchema(categories?: AnamnesisCategory[]) {
  return z
    .array(buildAnamnesisFieldSchema(categories))
    .describe("Medical history collected from patient");
}
