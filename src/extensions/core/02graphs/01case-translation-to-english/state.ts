import { GenerationFlagSchema } from "@/extensions/core/models/GenerationFlags.js";
import z from "zod";
import { DiagnosisSchema } from "@/extensions/core/models/Diagnosis.js";
import { ForeignLanguageSchema } from "@/extensions/core/models/Language.js";
import { AnamnesisCategorySchema } from "@/extensions/core/models/Anamnesis.js";

export const CaseTranslationToEnglishStateSchema = z.object({
  diagnosis: DiagnosisSchema,

  anamnesisCategories: z.array(AnamnesisCategorySchema).optional(),

  /**
   * Generation flags to control case generation behavior
   */
  generationFlags: z.array(GenerationFlagSchema).min(1),

  /**
   * Language for the case.
   */
  language: ForeignLanguageSchema,
});

/**
 * Type alias for the state shape
 */
export type CaseTranslationToEnglishState = z.infer<
  typeof CaseTranslationToEnglishStateSchema
>;
