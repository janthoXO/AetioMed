import {
  AllGenerationFlags,
  GenerationFlagsSchema,
} from "../../domain-models/GenerationFlags.js";
import { InconsistencySchema } from "../../domain-models/Inconsistency.js";
import z from "zod";
import { CaseWithDraftIndexSchema } from "./models.js";
import { CaseSchema } from "@/domain-models/Case.js";

export const GraphInputSchema = z.object({
  diagnosis: z.string(),
  context: z.string(),
  generationFlags: z.array(GenerationFlagsSchema).default(AllGenerationFlags),
});

export type GraphInput = z.infer<typeof GraphInputSchema>;

export const GlobalStateSchema = z.object({
  /**
   * The medical diagnosis to generate a case for
   */
  diagnosis: z.string(),
  /**
   * Optional context to guide case generation
   */
  context: z.string(),
  /**
   * Generation flags to control case generation behavior
   */
  generationFlags: z.array(GenerationFlagsSchema),

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
  inconsistencyIterationsRemaining: z.number().default(3),
});

/**
 * Type alias for the state shape
 */
export type GlobalState = z.infer<typeof GlobalStateSchema>;
