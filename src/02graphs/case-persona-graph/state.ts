import { GenerationFlagSchema } from "@/models/GenerationFlags.js";
import z from "zod";
import { CaseSchema } from "@/models/Case.js";
import { AnamnesisCategorySchema } from "@/models/Anamnesis.js";
import { DiagnosisSchema } from "@/models/Diagnosis.js";
import { SymptomSchema } from "@/models/Symptom.js";

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
