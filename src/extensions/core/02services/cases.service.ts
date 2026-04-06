import { type AnamnesisCategory } from "../models/Anamnesis.js";
import { type Case } from "../models/Case.js";
import type { GenerationFlag } from "../models/GenerationFlags.js";
import type { Language } from "../models/Language.js";
import { generateCase as graphGenerateCase } from "../02graphs/caseGraph.js";
import { translateAnamnesisCategoriesToEnglish } from "./anamnesis.service.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import type { UserInstructions } from "../models/UserInstructions.js";
import { bus } from "@/extensions/core/index.js";

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

    bus.emit("Generation Completed", { case: generatedCase });
    return generatedCase;
  } catch (error) {
    if (error instanceof Error) {
      bus.emit("Generation Failure", { error: error });
    }
    throw error;
  }
}
