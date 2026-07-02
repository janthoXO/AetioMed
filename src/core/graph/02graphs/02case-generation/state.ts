import { GenerationFlagSchema } from "@/core/graph/models/GenerationFlags.js";
import z from "zod";
import { CaseSchema } from "@/core/graph/models/Case.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { SymptomSchema } from "@/core/graph/models/Symptom.js";
import { registry } from "@langchain/langgraph/zod";
import { UserInstructionsSchema } from "@/core/graph/models/UserInstructions.js";
import { DifficultySchema } from "@/core/graph/models/Difficulty.js";

export const CaseGenerationStateSchema = z.object({
  diagnosis: DiagnosisSchema,
  userInstructions: UserInstructionsSchema.optional(),
  generationFlags: z.array(GenerationFlagSchema).min(1),
  /**
   * How unclear the diagnosis should be to a student working through the case.
   */
  difficulty: DifficultySchema.default("medium"),
  /**
   * Generated cases.
   */
  case: CaseSchema.default({}).register(registry, {
    reducer: {
      fn: (prev, next) => ({
        ...prev,
        ...next,
      }),
    },
  }),

  /**
   * Retrieved symptoms for the diagnosis.
   */
  symptoms: SymptomSchema.array().default([]),

  /**
   * The case blueprint generated at the start of the presentation phase.
   * Threaded to field generation and procedure-result generation, but
   * never to the blinded procedure solver.
   */
  outline: z.string().optional(),
});

/**
 * Type alias for the state shape
 */
export type CaseGenerationState = z.infer<typeof CaseGenerationStateSchema>;
