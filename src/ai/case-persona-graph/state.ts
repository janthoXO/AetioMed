import { GenerationFlagSchema } from "../../domain-models/GenerationFlags.js";
import z from "zod";
import { CaseSchema } from "@/domain-models/Case.js";
import {
  AnamnesisCategorySchema,
  AnamnesisCategoryDefaults,
} from "@/domain-models/Anamnesis.js";
import { DiagnosisSchema } from "@/domain-models/Diagnosis.js";
import { SymptomSchema } from "@/domain-models/Symptom.js";

export const GraphInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  userInstructions: z.string().optional(),
  generationFlags: z.array(GenerationFlagSchema),
  anamnesisCategories: z
    .array(AnamnesisCategorySchema)
    .default(AnamnesisCategoryDefaults),
});

export type GraphInput = z.infer<typeof GraphInputSchema>;

export const GlobalStateSchema = GraphInputSchema.extend({
  /**
   * Generated cases.
   */
  case: CaseSchema.default({}),

  /**
   * Retrieved symptoms for the diagnosis.
   */
  symptoms: SymptomSchema.array().default([]),

  /**
   * Maximum remaining iterations for the refinement loop.
   * Decrements each loop to prevent infinite cycles.
   */
  refinementIterationsRemaining: z.number().default(2),
});

/**
 * Type alias for the state shape
 */
export type GlobalState = z.infer<typeof GlobalStateSchema>;
