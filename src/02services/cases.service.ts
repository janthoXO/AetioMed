import { type AnamnesisCategory } from "@/02domain-models/Anamnesis.js";
import { type Case } from "@/02domain-models/Case.js";
import type { GenerationFlag } from "@/02domain-models/GenerationFlags.js";
import type { Language } from "@/02domain-models/Language.js";
import { generateCase as graphGenerateCase } from "@/02ai/case-persona-graph/index.js";
import { translateCase } from "@/02ai/translation-graph/index.js";
import { translateAnamnesisCategoriesToEnglish } from "./anamnesis.service.js";
import type { Diagnosis } from "@/02domain-models/Diagnosis.js";

export async function generateCase(
  diagnosis: Diagnosis,
  generationFlags: GenerationFlag[],
  userInstructions?: string,
  language?: Language,
  anamnesisCategories?: AnamnesisCategory[]
): Promise<Case> {
  // translate anamnesis categories to English if needed
  if (anamnesisCategories && language && language !== "English") {
    const translatedCategories = await translateAnamnesisCategoriesToEnglish(
      anamnesisCategories,
      language
    );

    anamnesisCategories = Object.values(translatedCategories);
  }

  let generatedCase = await graphGenerateCase(
    diagnosis,
    generationFlags,
    userInstructions,
    anamnesisCategories
  );

  if (language) {
    generatedCase = await translateCase(generatedCase, language);
  }

  return generatedCase;
}
