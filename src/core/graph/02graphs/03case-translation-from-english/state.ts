import { GenerationFlagSchema } from "@/core/graph/models/GenerationFlags.js";
import z from "zod";
import { CaseSchema } from "@/core/graph/models/Case.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { UserInstructionsSchema } from "@/core/graph/models/UserInstructions.js";
import { registry } from "@langchain/langgraph/zod";

/**
 * Catalog-backed translations for the controlled vocabulary — issue 12 §1.
 * Written only by `translate_defined`, kept off `case` entirely so
 * `translate_merge` is the only node that ever writes `case`.
 */
export const DefinedTranslationsSchema = z.object({
  procedureNames: z.record(z.string(), z.string()),
  anamnesisCategories: z.record(z.string(), z.string()),
});
export type DefinedTranslations = z.infer<typeof DefinedTranslationsSchema>;

// No `language` field (issue 09 §2): this subgraph's target language is the
// request's, carried on `AsyncLocalStorage` (`utils/context.ts`), not graph
// state — see `index.ts`'s node functions.
export const CaseTranslationFromEnglishStateSchema = z.object({
  diagnosis: DiagnosisSchema,

  /**
   * Optional instructions to guide case generation
   */
  userInstructions: UserInstructionsSchema.optional(),

  /**
   * Generation flags to control case generation behavior
   */
  generationFlags: z.array(GenerationFlagSchema).min(1),

  /**
   * Generated case. Written only by `translate_merge` (issue 12 §1) — the
   * two translation passes below write to their own channels instead, so
   * this shallow-merge reducer never has to arbitrate between two competing
   * writers.
   *
   * `.default({})` before `.register(...)` (issue 17 §2b), matching
   * `02case-generation/state.ts`: `.register()` attaches the reducer to the
   * exact Zod instance it is called on, and `CaseSchema` bare is the same
   * instance `api/contentWire.ts` and the API schemas use. Registering that
   * shared instance directly would put a graph-framework reducer on a
   * domain model, and a second graph doing the same would silently
   * overwrite this one's registration. `.default({})` produces a fresh
   * wrapper instance to register instead — harmless here, since this
   * channel is always supplied by the parent (`assembleCaseGraph` never
   * enters this phase without a `case` already generated) and the default
   * is never actually used.
   */
  case: CaseSchema.default({}).register(registry, {
    reducer: {
      fn: (prev, next) => ({
        ...prev,
        ...next,
      }),
    },
  }),

  /**
   * Written only by `translate_defined` (issue 12 §1): catalog dictionary
   * lookups (with per-key locked LLM fill on a cache miss) for
   * `procedures[].name` and `anamnesis[].category` — the controlled
   * vocabulary that must never be overwritten by the free-text rest pass.
   */
  definedTranslations: DefinedTranslationsSchema.default({
    procedureNames: {},
    anamnesisCategories: {},
  }),

  /**
   * Written only by `translate_rest` (issue 12 §1/§2): one free-text LLM
   * pass over every `ContentPart` text fragment in the case — both `alt`
   * and, for text parts, the decoded `value` — keyed by stable path
   * (`tools.ts`'s `caseTextMap`). `translate_merge` applies the translated
   * `.text` entry to `value` and the translated `.alt` entry to `alt`
   * independently for `text/plain` parts, and leaves every other part's
   * `value` byte-identical.
   */
  restTranslations: z.record(z.string(), z.string()).default({}),
});

/**
 * Type alias for the state shape
 */
export type CaseTranslationFromEnglishState = z.infer<
  typeof CaseTranslationFromEnglishStateSchema
>;
