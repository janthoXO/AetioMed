import { GenerationFlagSchema } from "../../domain-models/GenerationFlags.js";
import { InconsistencySchema } from "../../domain-models/Inconsistency.js";
import z from "zod";
import { CaseWithDraftIndexSchema } from "./models.js";
import { CaseSchema } from "@/domain-models/Case.js";
import {
  AnamnesisCategorySchema,
  AnamnesisCategoryDefaults,
} from "@/domain-models/Anamnesis.js";
import { DiagnosisSchema } from "@/domain-models/Diagnosis.js";

export const GraphInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  context: z.string().optional(),
  generationFlags: z.array(GenerationFlagSchema),
  anamnesisCategories: z
    .array(AnamnesisCategorySchema)
    .default(AnamnesisCategoryDefaults),
});

export type GraphInput = z.infer<typeof GraphInputSchema>;

export const GlobalStateSchema = z.object({
  /**
   * The medical diagnosis to generate a case for
   */
  diagnosis: DiagnosisSchema,
  /**
   * Optional context to guide case generation
   */
  context: z.string().optional(),
  /**
   * Generation flags to control case generation behavior
   */
  generationFlags: z.array(GenerationFlagSchema),

  /**
   * Anamnesis categories to include in the case
   */
  anamnesisCategories: z
    .array(AnamnesisCategorySchema)
    .default(AnamnesisCategoryDefaults),

  /**
   * Generated cases.
   */
  case: CaseSchema.optional(),

  /**
   * All generated drafts.
   */
  drafts: z.array(CaseWithDraftIndexSchema).default([]),

  /**
   * Map of field name to inconsistency.
   */
  inconsistencies: z.array(InconsistencySchema).default([]),

  /**
   * Maximum remaining iterations for the refinement loop.
   * Decrements each loop to prevent infinite cycles.
   */
  loopIterationsRemaining: z.number().default(2),
});

/**
 * Type alias for the state shape
 */
export type GlobalState = z.infer<typeof GlobalStateSchema>;
