import { encode } from "@toon-format/toon";

export enum AnamnesisCategory {
  HPI = "History of Present Illness",
  PMH = "Past Medical History",
  Medications = "Medications",
  Allergies = "Allergies",
  FamilyHistory = "Family History",
  CVRiskFactors = "Cardiovascular Risk Factors",
  SH = "Social and Occupational History",
}

enum AnamnesisCategoryGER {
  Krankheitsverlauf = "Krankheitsverlauf",
  Vorerkrankungen = "Vorerkrankungen",
  Medikamente = "Medikamente",
  Allergien = "Allergien",
  Familienanamnese = "Familienanamnese",
  KardiovaskuläreRisikofaktoren = "Kardiovaskuläre Risikofaktoren",
  SozialBerufsanamnese = "Sozial-/Berufsanamnese",
}

export interface AnamnesisField {
  category: AnamnesisCategory;
  answer: string;
}

export function AnamnesisToonFormat(): string {
  // Generate an example structure for the LLM to follow
  const example: AnamnesisField[] = [
    {
      category: AnamnesisCategory.HPI,
      answer: "Patient reports...",
    },
  ];
  return `${encode(example)}\nthe following categories are allowed: ${Object.values(
    AnamnesisCategory
  )
    .map((category) => `"${category}"`)
    .join("|")}`;
}
