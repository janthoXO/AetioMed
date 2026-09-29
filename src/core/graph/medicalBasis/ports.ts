import z from "zod";
import {
  DiagnosisSchema,
  type Diagnosis,
} from "@/core/graph/models/Diagnosis.js";
import {
  DifficultySchema,
  type Difficulty,
} from "@/core/graph/models/Difficulty.js";
import type { Symptom } from "@/core/graph/models/Symptom.js";
import type { ICDCode } from "@/core/graph/models/Diagnosis.js";
import type { RequestContext } from "@/core/graph/utils/context.js";

/** Provider input: diagnosis, difficulty, user instructions only. No outline, flags or language. */
export type BasisQuery = {
  diagnosis: Diagnosis;
  difficulty: Difficulty;
  userInstructions?: string | undefined;
};

/** Zod counterpart of {@link BasisQuery}, for tools/nodes that need it. */
export const BasisQuerySchema = z.object({
  diagnosis: DiagnosisSchema,
  difficulty: DifficultySchema,
  userInstructions: z.string().optional(),
});

/**
 * One provider's contribution to the plan prompt. `source` is the provider's
 * `description`, shown as the fragment's header. Zod schema because it lives
 * on graph state (`CaseGenerationStateSchema.basisFragments`).
 */
export const BasisFragmentSchema = z.object({
  source: z.string(),
  content: z.string(),
});

export type BasisFragment = z.infer<typeof BasisFragmentSchema>;

/**
 * Source of disease knowledge for the plan stage. Returns plain text, or
 * `undefined` when it has nothing for this query (not rendered). May throw;
 * `resolveAllFragments` logs and skips a throwing provider.
 *
 * `fetch` takes whole `RequestContext`, not just `AbortSignal`: under
 * `ALLOW_LLMS`, `llmConfig` is the only source of provider/model, needed by
 * providers that call an LLM (`llmSymptoms` on cache miss).
 */
export interface MedicalBasisProvider {
  readonly id: string;
  /** What the provider supplies; header of its fragment in the prompt. */
  readonly description: string;
  fetch(
    query: BasisQuery,
    context?: RequestContext
  ): Promise<string | undefined>;
}

export interface SymptomsRepo {
  SymptomsRelatedToDiagnosisIcd(icdCode: ICDCode): Symptom[];
  /**
   * Return the cached LLM-generated symptoms for `icdCode`, or `undefined`
   * if there is no entry or it is older than the TTL (a miss, requiring
   * regeneration).
   */
  getCachedSymptoms(icdCode: ICDCode, nowMs?: number): Symptom[] | undefined;
  /**
   * Upsert the LLM-generated symptoms for `icdCode`, refreshing `updatedAt`
   * so the TTL window restarts from this write.
   */
  saveCachedSymptoms(icdCode: ICDCode, symptoms: Symptom[]): void;
}
