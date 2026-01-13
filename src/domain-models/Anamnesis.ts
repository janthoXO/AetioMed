import { z } from "zod/v4";

/**
 * Anamnesis categories for medical history
 */
export enum AnamnesisCategory {
  HPI = "History of Present Illness",
  PMH = "Past Medical History",
  Medications = "Medications",
  Allergies = "Allergies",
  FamilyHistory = "Family History",
  CVRiskFactors = "Cardiovascular Risk Factors",
  SH = "Social and Occupational History",
}

/**
 * German translations for anamnesis categories
 */
export enum AnamnesisCategoryGER {
  Krankheitsverlauf = "Krankheitsverlauf",
  Vorerkrankungen = "Vorerkrankungen",
  Medikamente = "Medikamente",
  Allergien = "Allergien",
  Familienanamnese = "Familienanamnese",
  KardiovaskuläreRisikofaktoren = "Kardiovaskuläre Risikofaktoren",
  SozialBerufsanamnese = "Sozial-/Berufsanamnese",
}

/**
 * Zod schema for an anamnesis field
 */
export const AnamnesisFieldSchema = z.object({
  category: z.enum(AnamnesisCategory).describe("Category of anamnesis"),
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
  const exampleAnamnesis = Object.values(AnamnesisCategory).map((category) => ({
    category: category,
    answer: "The patient's response or clinical finding",
  }));

  return exampleAnamnesis;
}

/**
 * 
 * @returns a TOON format string representing {anamnesis: Anamnesis[]}

 */
export function AnamnesisToonFormat(): string {
  const categories = Object.values(AnamnesisCategory);
  return `anamnesis[7]{category,answer}:
${categories
  .map(
    (category, idx) =>
      `  ${category},${idx === 0 ? `"The patient reports..."` : `"..."`}`
  )
  .join("\n")}`;
}
