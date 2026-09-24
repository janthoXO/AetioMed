import { GenerationFlagSchema } from "@/core/graph/models/GenerationFlags.js";
import z from "zod";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { UserInstructionsSchema } from "@/core/graph/models/UserInstructions.js";

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
