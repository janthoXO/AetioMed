import { type AnamnesisCategory } from "@/core/models/Anamnesis.js";
import { type Case } from "@/core/models/Case.js";
import type { GenerationFlag } from "@/core/models/GenerationFlags.js";
import type { Language } from "@/core/models/Language.js";
import { generateCase as graphGenerateCase } from "@/core/02graphs/caseGraph.js";
import { translateAnamnesisCategoriesToEnglish } from "./anamnesis.service.js";
import type { Diagnosis } from "@/core/models/Diagnosis.js";
import type { UserInstructions } from "@/core/models/UserInstructions.js";
import { publishEvent } from "@/core/eventBus/index.js";

export async function generateCase(
  diagnosis: Diagnosis,
  generationFlags: GenerationFlag[],
  userInstructions?: UserInstructions,
  language?: Language,
  anamnesisCategories?: AnamnesisCategory[]
): Promise<Case> {
  try {
    // translate anamnesis categories to English if needed
    if (anamnesisCategories && language && language !== "English") {
      const translatedCategories = await translateAnamnesisCategoriesToEnglish(
        anamnesisCategories,
        language
      );

      anamnesisCategories = Object.values(translatedCategories);
    }

    const generatedCase = await graphGenerateCase(
      diagnosis,
      generationFlags,
      userInstructions,
      language,
      anamnesisCategories
    );

    publishEvent("Generation Completed", { case: generatedCase });
    return generatedCase;
  } catch (error) {
    if (error instanceof Error) {
      publishEvent("Generation Failure", { error: error });
    }
    throw error;
  }
}
