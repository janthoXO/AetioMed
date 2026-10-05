import { GenerationFlagSchema } from "@/core/graph/shared/domain/GenerationFlags.js";
import z from "zod";
import { DiagnosisSchema } from "@/core/graph/shared/domain/Diagnosis.js";
import { UserInstructionsSchema } from "@/core/graph/shared/domain/UserInstructions.js";

// No `language` field: target language lives on ALS (`utils/context.ts`).
export const CaseTranslationToEnglishStateSchema = z.object({
  diagnosis: DiagnosisSchema,

  /** Caller instructions; translated to English alongside `diagnosis`. */
  userInstructions: UserInstructionsSchema.optional(),

  generationFlags: z.array(GenerationFlagSchema).min(1),
});

export type CaseTranslationToEnglishState = z.infer<
  typeof CaseTranslationToEnglishStateSchema
>;
