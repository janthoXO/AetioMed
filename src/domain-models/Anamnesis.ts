import { z } from "zod/v4";

export const AnamnesisCategoryDefaultSchema = z.enum([
  "History of Present Illness",
  "Past Medical History",
  "Medications",
  "Allergies",
  "Family History",
  "Cardiovascular Risk Factors",
  "Social and Occupational History",
]);

export const AnamnesisCategoryDefaults = AnamnesisCategoryDefaultSchema.options;

/**
 * Anamnesis categories for medical history
 */
export type AnamnesisCategoryDefaults = z.infer<
  typeof AnamnesisCategoryDefaultSchema
>;

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
