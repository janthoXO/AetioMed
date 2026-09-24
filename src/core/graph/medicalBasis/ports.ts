import z from "zod";
import {
  DiagnosisSchema,
  type Diagnosis,
} from "@/core/graph/models/Diagnosis.js";
import {
  DifficultySchema,
  type Difficulty,
} from "@/core/graph/models/Difficulty.js";
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
 * One labelled slab of third-party content for the plan prompt.
 * `retrievedAt` from `runtime.clock()`, never `new Date()`. Zod schema
 * because it lives on graph state (`CaseGenerationStateSchema.basisFragments`).
 */
export const BasisFragmentSchema = z.object({
  sourceId: z.string(),
  /** Section heading in the rendered prompt. */
  label: z.string(),
  content: z.string(),
  /** ISO 8601, from `runtime.clock()`. */
  retrievedAt: z.string(),
  licence: z.string().optional(),
});

export type BasisFragment = z.infer<typeof BasisFragmentSchema>;

/**
 * Source of disease knowledge for the plan stage. May return zero or more
 * fragments and may throw; `resolveAllFragments` logs and skips a throwing
 * provider.
 *
 * `fetch` takes whole `RequestContext`, not just `AbortSignal`: under
 * `ALLOW_LLMS`, `llmConfig` is the only source of provider/model, needed by
 * providers that call an LLM (`umlsSymptoms` on cache miss).
 */
export interface MedicalBasisProvider {
  readonly id: string;
  fetch(query: BasisQuery, context?: RequestContext): Promise<BasisFragment[]>;
}
