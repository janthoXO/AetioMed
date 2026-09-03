import { GenerationFlagSchema } from "@/core/graph/models/GenerationFlags.js";
import z from "zod";
import { CaseSchema } from "@/core/graph/models/Case.js";
import { AnamnesisCategorySchema } from "@/core/graph/models/Anamnesis.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { SymptomSchema } from "@/core/graph/models/Symptom.js";
import { registry } from "@langchain/langgraph/zod";
import { UserInstructionsSchema } from "@/core/graph/models/UserInstructions.js";

export const CaseGenerationStateSchema = z.object({
  diagnosis: DiagnosisSchema,
  userInstructions: UserInstructionsSchema.optional(),
  generationFlags: z.array(GenerationFlagSchema).min(1),
  anamnesisCategories: z.array(AnamnesisCategorySchema).optional(),
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
});

/**
 * Type alias for the state shape
 */
export type CaseGenerationState = z.infer<typeof CaseGenerationStateSchema>;
