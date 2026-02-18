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
  case: CaseSchema.optional(),

  /**
   * Retrieved symptoms for the diagnosis.
   */
  symptoms: SymptomSchema.array().default([]),
});

/**
 * Type alias for the state shape
 */
export type GlobalState = z.infer<typeof GlobalStateSchema>;
