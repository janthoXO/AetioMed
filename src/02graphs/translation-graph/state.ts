import {
  AllGenerationFlags,
  GenerationFlagSchema,
} from "@/02domain-models/GenerationFlags.js";
import z from "zod";
import { CaseSchema } from "@/02domain-models/Case.js";
import { ICDCodeSchema } from "@/02domain-models/Diagnosis.js";
import { LanguageSchema } from "@/02domain-models/Language.js";

export const GlobalStateSchema = z.object({
  /**
   * The ICD code for the diagnosis
   */
  icdCode: ICDCodeSchema.optional(),

  /**
   * The medical diagnosis to generate a case for
   */
  diagnosis: z.string(),

  /**
   * Optional context to guide case generation
   */
  context: z.string().optional(),

  /**
   * Generation flags to control case generation behavior
   */
  generationFlags: z.array(GenerationFlagSchema).default(AllGenerationFlags),

  /**
   * Generated case.
   */
  case: CaseSchema,

  /**
   * Language for the case.
   */
  language: LanguageSchema.exclude(["English"]),
});

/**
 * Type alias for the state shape
 */
export type GlobalState = z.infer<typeof GlobalStateSchema>;
