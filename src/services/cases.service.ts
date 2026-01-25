import type { AnamnesisCategory } from "@/domain-models/Anamnesis.js";
import type { Case } from "@/domain-models/Case.js";
import type { GenerationFlags } from "@/domain-models/GenerationFlags.js";
import type { Language } from "@/domain-models/Language.js";
import { generateCase as graphGenerateCase } from "@/graph/case-generation/index.js";
import { translateCase } from "@/graph/translation/index.js";
import { translateAnamnesisCategoriesToEnglish } from "./anamnesis.service.js";

export async function generateCase(
  icdCode: string | undefined,
  diseaseName: string,
  generationFlags: GenerationFlags[],
  context?: string,
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
    icdCode,
    diseaseName,
    generationFlags,
    context,
    anamnesisCategories
  );

  if (language) {
    generatedCase = await translateCase(generatedCase, language);
  }

  return generatedCase;
}
