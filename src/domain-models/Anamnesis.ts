import { z } from "zod/v4";
import type { Language } from "./Language.js";

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

export const AnamnesisCategoryTranslation: Record<
  AnamnesisCategory,
  Record<Language, AnamnesisCategory | AnamnesisCategoryGER>
> = {
  [AnamnesisCategory.HPI]: {
    English: AnamnesisCategory.HPI,
    German: AnamnesisCategoryGER.Krankheitsverlauf,
  },
  [AnamnesisCategory.PMH]: {
    English: AnamnesisCategory.PMH,
    German: AnamnesisCategoryGER.Vorerkrankungen,
  },
  [AnamnesisCategory.Medications]: {
    English: AnamnesisCategory.Medications,
    German: AnamnesisCategoryGER.Medikamente,
  },
  [AnamnesisCategory.Allergies]: {
    English: AnamnesisCategory.Allergies,
    German: AnamnesisCategoryGER.Allergien,
  },
  [AnamnesisCategory.FamilyHistory]: {
    English: AnamnesisCategory.FamilyHistory,
    German: AnamnesisCategoryGER.Familienanamnese,
  },
  [AnamnesisCategory.CVRiskFactors]: {
    English: AnamnesisCategory.CVRiskFactors,
    German: AnamnesisCategoryGER.KardiovaskuläreRisikofaktoren,
  },
  [AnamnesisCategory.SH]: {
    English: AnamnesisCategory.SH,
    German: AnamnesisCategoryGER.SozialBerufsanamnese,
  },
};

const AnamnesisCategoryByLanguage = (language: Language = "English") => {
  switch (language) {
    case "English":
      return AnamnesisCategory;
    case "German":
      return AnamnesisCategoryGER;
  }
};

export const AnamnesisFieldSchema = z.object({
  category: z.union([z.enum(AnamnesisCategory), z.enum(AnamnesisCategoryGER)]),
  answer: z.string().describe("Patient's response or clinical finding"),
});

/**
 * Zod schema for an anamnesis field
 */
export const AnamnesisFieldSchemaWithLanguage = (
  language: Language = "English"
) => {
  return AnamnesisFieldSchema.extend({
    category: z.enum(AnamnesisCategoryByLanguage(language)),
  });
};

export type AnamnesisField = z.infer<typeof AnamnesisFieldSchema>;

/**
 * Zod schema for the complete anamnesis array
 */
export const AnamnesisSchema = z
  .array(AnamnesisFieldSchema)
  .describe("Medical history collected from patient");

export const AnamnesisSchemaWithLanguage = (language: Language = "English") => {
  return z.array(AnamnesisFieldSchemaWithLanguage(language));
};

export type Anamnesis = z.infer<typeof AnamnesisSchema>;

export function AnamnesisDescriptionPrompt(): string {
  return "Anamnesis: Medical history with multiple categories";
}

export function AnamnesisJsonExample(
  language: Language = "English"
): Anamnesis {
  let exampleAnswer: string;
  switch (language) {
    case "English": {
      exampleAnswer = "The patient's response or clinical finding";
      break;
    }
    case "German": {
      exampleAnswer = "Die Patienten Antwort oder klinischer Befund";
      break;
    }
  }

  return Object.values(AnamnesisCategoryByLanguage(language)).map(
    (category) => ({
      category: category,
      answer: exampleAnswer,
    })
  );
}

/**
 * 
 * @returns a TOON format string representing {anamnesis: Anamnesis[]}

 */
export function AnamnesisToonFormat(language: Language = "English"): string {
  let exampleAnswer: string;

  switch (language) {
    case "English": {
      exampleAnswer = "The patient reports...";
      break;
    }
    case "German": {
      exampleAnswer = "The patient reports...";
      break;
    }
  }

  return `anamnesis[7]{category,answer}:
${Object.values(AnamnesisCategoryByLanguage(language))
  .map(
    (category, idx) =>
      `  ${category},${idx === 0 ? `${exampleAnswer}` : `"..."`}`
  )
  .join("\n")}`;
}
