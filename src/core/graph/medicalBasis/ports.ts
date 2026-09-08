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

/**
 * What a provider is asked to ground its fragments in. Deliberately narrow —
 * a provider gets the diagnosis, the difficulty (some sources vary depth by
 * how obscure the case should be) and any free-text user instructions, and
 * nothing else. It is not handed the outline, the generation flags, or the
 * language: those belong to the plan node, not to knowledge retrieval.
 */
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
 * One labelled slab of third-party content destined for the plan prompt.
 * `retrievedAt` must come from `runtime.clock()`, never `new Date()`
 * directly, so tests can freeze time and assert on it. A zod schema (rather
 * than a plain type, like `BasisQuery`) because it lives on graph state
 * (`CaseGenerationStateSchema.basisFragments`, see `02case-generation/state.ts`).
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
 * A source of disease knowledge the plan stage can draw on. `umlsSymptoms`
 * (see `providers/umlsSymptoms.ts`) is the first and, as of this branch, the
 * only one — a database lookup, a medical journal API, or a hospital
 * system's own data are meant to implement this without the plan stage
 * forking.
 *
 * A provider may return zero or more fragments (e.g. nothing relevant found)
 * and may throw — the registry's `resolveAllFragments` logs and skips a
 * throwing provider rather than failing the whole generation (see
 * `registry.ts`).
 *
 * `fetch` takes the whole `RequestContext`, not just an `AbortSignal`. Issue
 * 14 sketched the narrower signature, and it is wrong: `RequestContext` also
 * carries `llmConfig`, which under `ALLOW_LLMS` is the *only* source of
 * provider/model — with no global LLM configured, a provider that makes an
 * LLM call (as `umlsSymptoms` does on a cold cache miss) would fail schema
 * validation without it. The signal-only shape would have been a silent
 * regression against the node this replaces, which read the full context off
 * `lgRuntime?.context`. The issue anticipates exactly this: "if the port
 * cannot express it cleanly, change the port, not the provider."
 *
 * It also matches every other seam in the codebase — `Tool.invoke`, and each
 * `03aigateway/` function, take `context?: RequestContext`.
 */
export interface MedicalBasisProvider {
  readonly id: string;
  fetch(query: BasisQuery, context?: RequestContext): Promise<BasisFragment[]>;
}
