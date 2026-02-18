import { GenerationFlagSchema } from "@/02domain-models/GenerationFlags.js";
import z from "zod";
import { CaseSchema } from "@/02domain-models/Case.js";
import { AnamnesisCategorySchema } from "@/02domain-models/Anamnesis.js";
import { DiagnosisSchema } from "@/02domain-models/Diagnosis.js";
import { SymptomSchema } from "@/02domain-models/Symptom.js";

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
