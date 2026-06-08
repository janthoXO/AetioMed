import { GenerationFlagSchema } from "@/core/graph/models/GenerationFlags.js";
import z from "zod";
import { CaseSchema } from "@/core/graph/models/Case.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { ForeignLanguageSchema } from "@/core/graph/models/Language.js";
import { UserInstructionsSchema } from "@/core/graph/models/UserInstructions.js";
import { registry } from "@langchain/langgraph/zod";

export const CaseTranslationFromEnglishStateSchema = z.object({
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
export type CaseTranslationFromEnglishState = z.infer<
  typeof CaseTranslationFromEnglishStateSchema
>;
