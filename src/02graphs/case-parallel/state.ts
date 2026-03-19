import { GenerationFlagSchema } from "@/models/GenerationFlags.js";
import z from "zod";
import { CaseSchema } from "@/models/Case.js";
import { AnamnesisCategorySchema } from "@/models/Anamnesis.js";
import { DiagnosisSchema } from "@/models/Diagnosis.js";
import { SymptomSchema } from "@/models/Symptom.js";
import { registry } from "@langchain/langgraph/zod";

export const GraphInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  userInstructions: z.string().optional(),
  generationFlags: z.array(GenerationFlagSchema),
  anamnesisCategories: z.array(AnamnesisCategorySchema).optional(),
});

export type GraphInput = z.infer<typeof GraphInputSchema>;

export const GlobalStateSchema = GraphInputSchema.extend({
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
   * Generated outline for the case.
   */
  outline: z.string(),
});

/**
 * Type alias for the state shape
 */
export type GlobalState = z.infer<typeof GlobalStateSchema>;
