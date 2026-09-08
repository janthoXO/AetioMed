import { GenerationFlagSchema } from "@/core/graph/models/GenerationFlags.js";
import z from "zod";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { UserInstructionsSchema } from "@/core/graph/models/UserInstructions.js";

// No `language` field (issue 09 §2): this subgraph's target language is the
// request's, carried on `AsyncLocalStorage` (`utils/context.ts`), not graph
// state — see `index.ts`'s node functions.
export const CaseTranslationToEnglishStateSchema = z.object({
  diagnosis: DiagnosisSchema,

  /**
   * Optional instructions to guide case generation. Translated to English
   * alongside `diagnosis` (issue 12 §3) — free text supplied by the caller
   * that would otherwise flow into English generation prompts unmodified.
   */
  userInstructions: UserInstructionsSchema.optional(),

  /**
   * Generation flags to control case generation behavior
   */
  generationFlags: z.array(GenerationFlagSchema).min(1),
});

/**
 * Type alias for the state shape
 */
export type CaseTranslationToEnglishState = z.infer<
  typeof CaseTranslationToEnglishStateSchema
>;
