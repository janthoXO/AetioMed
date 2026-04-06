import { GenerationFlagSchema } from "@/extensions/core/models/GenerationFlags.js";
import z from "zod";
import { CaseSchema } from "@/extensions/core/models/Case.js";
import { AnamnesisCategorySchema } from "@/extensions/core/models/Anamnesis.js";
import { DiagnosisSchema } from "@/extensions/core/models/Diagnosis.js";
import { SymptomSchema } from "@/extensions/core/models/Symptom.js";
import { registry } from "@langchain/langgraph/zod";
import { UserInstructionsSchema } from "@/extensions/core/models/UserInstructions.js";

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
