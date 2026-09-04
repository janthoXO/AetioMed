import { z } from "zod/v4";
import { ContentPartsSchema } from "./ContentPart.js";

export const AnamnesisCategorySchema = z.string();

export type AnamnesisCategory = z.infer<typeof AnamnesisCategorySchema>;

/**
 * Domain shape: the patient's answer as one or more content parts
 * (issue 11). See `ContentPart.ts` for additive-parts semantics.
 */
export const AnamnesisFieldSchema = z.object({
  category: AnamnesisCategorySchema.describe("Category of the anamnesis field"),
  answer: ContentPartsSchema.describe(
    "Patient's response or clinical finding, as one or more content parts"
  ),
});

export type AnamnesisField = z.infer<typeof AnamnesisFieldSchema>;

/**
 * Zod schema for the complete anamnesis array
 */
export const AnamnesisSchema = z
  .array(AnamnesisFieldSchema)
  .describe("Medical history collected from patient");

export type Anamnesis = z.infer<typeof AnamnesisSchema>;

/**
 * LLM-facing shape: the generator produces ordinary text under a plain
 * `z.string()` `answer` field — the LLM is never asked to emit bytes or
 * base64 (issue 11 §3). The gateway wraps `answer` with `textPart()` to
 * build a domain `AnamnesisField` above.
 */
const AnamnesisFieldTextSchema = z.object({
  category: AnamnesisCategorySchema.describe("Category of the anamnesis field"),
  answer: z.string().describe("Patient's response or clinical finding"),
});

export type AnamnesisFieldText = z.infer<typeof AnamnesisFieldTextSchema>;

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
