import { type AnamnesisCategory } from "@/domain-models/Anamnesis.js";
import { type Case } from "@/domain-models/Case.js";
import type { GenerationFlag } from "@/domain-models/GenerationFlags.js";
import type { Language } from "@/domain-models/Language.js";
import { generateCase as graphGenerateCase } from "@/ai/case-persona-graph/index.js";
import { translateCase } from "@/ai/translation-graph/index.js";
import { translateAnamnesisCategoriesToEnglish } from "./anamnesis.service.js";
import type { Diagnosis } from "@/domain-models/Diagnosis.js";

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
