import { GenerationFlagSchema } from "@/core/graph/shared/domain/GenerationFlags.js";
import z from "zod";
import { CaseSchema } from "@/core/graph/shared/domain/Case.js";
import { DiagnosisSchema } from "@/core/graph/shared/domain/Diagnosis.js";
import { UserInstructionsSchema } from "@/core/graph/shared/domain/UserInstructions.js";
import { registry } from "@langchain/langgraph/zod";

/** Catalog-backed translations of controlled vocabulary. Written only by `translate_defined`; kept off `case`. */
export const DefinedTranslationsSchema = z.object({
  /** `nodeKey(path) -> translated segment name`, for categories and procedures. */
  procedureNodes: z.record(z.string(), z.string()),
  anamnesisCategories: z.record(z.string(), z.string()),
});
export type DefinedTranslations = z.infer<typeof DefinedTranslationsSchema>;

// No `language` field: target language lives on ALS (`utils/context.ts`).
export const CaseTranslationFromEnglishStateSchema = z.object({
  diagnosis: DiagnosisSchema,

  userInstructions: UserInstructionsSchema.optional(),

  generationFlags: z.array(GenerationFlagSchema).min(1),

  /**
   * Generated case. Written only by `translate_merge`; passes write own channels, so reducer never arbitrates.
   *
   * `.default({})` before `.register(...)`: `.register()` attaches reducer to the exact Zod instance; bare `CaseSchema` is shared with API schemas. Default makes a fresh wrapper. Default never used; parent always supplies `case`.
   */
  case: CaseSchema.default({}).register(registry, {
    reducer: {
      fn: (prev, next) => ({
        ...prev,
        ...next,
      }),
    },
  }),

  /** Written only by `translate_defined`: catalog lookups (per-key locked LLM fill on miss) for `procedures[].name`, `anamnesis[].category`. Never overwritten by rest pass. */
  definedTranslations: DefinedTranslationsSchema.default({
    procedureNodes: {},
    anamnesisCategories: {},
  }),

  /** Written only by `translate_rest`: one LLM pass over every `ContentPart` `alt`, keyed by path (`caseTextMap`). `translate_merge` applies it to `alt`; every `value` stays byte-identical (already target language). */
  restTranslations: z.record(z.string(), z.string()).default({}),
});

export type CaseTranslationFromEnglishState = z.infer<
  typeof CaseTranslationFromEnglishStateSchema
>;
