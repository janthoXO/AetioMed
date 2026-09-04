import { GenerationFlagSchema } from "@/core/graph/models/GenerationFlags.js";
import z from "zod";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";

// No `language` field (issue 09 §2): this subgraph's target language is the
// request's, carried on `AsyncLocalStorage` (`utils/context.ts`), not graph
// state — see `index.ts`'s `translateDiagnosis`.
export const CaseTranslationToEnglishStateSchema = z.object({
  diagnosis: DiagnosisSchema,

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
