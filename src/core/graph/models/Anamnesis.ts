import { z } from "zod/v4";

export const AnamnesisCategorySchema = z.string();

export type AnamnesisCategory = z.infer<typeof AnamnesisCategorySchema>;

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
