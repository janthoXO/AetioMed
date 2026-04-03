import { GenerationFlagSchema } from "@/core/models/GenerationFlags.js";
import z from "zod";
import { CaseSchema } from "@/core/models/Case.js";
import { DiagnosisSchema } from "@/core/models/Diagnosis.js";
import { ForeignLanguageSchema } from "@/core/models/Language.js";
import { UserInstructionsSchema } from "@/core/models/UserInstructions.js";
import { registry } from "@langchain/langgraph/zod";

export const CaseTranslationStateSchema = z.object({
  diagnosis: DiagnosisSchema,

  /**
   * Optional instructions to guide case generation
   */
  userInstructions: UserInstructionsSchema.optional(),

  /**
   * Generation flags to control case generation behavior
   */
  generationFlags: z.array(GenerationFlagSchema).min(1),

  /**
   * Generated case.
   */
  case: CaseSchema.register(registry, {
    reducer: {
      fn: (prev, next) => ({
        ...prev,
        ...next,
      }),
    },
  }),

  /**
   * Language for the case.
   */
  language: ForeignLanguageSchema,
});

/**
 * Type alias for the state shape
 */
export type CaseTranslationState = z.infer<typeof CaseTranslationStateSchema>;
