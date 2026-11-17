import {
  AllGenerationFlags,
  GenerationFlagSchema,
} from "@/core/graph/shared/domain/GenerationFlags.js";
import { ICDCodeSchema } from "@/core/graph/shared/domain/Diagnosis.js";
import { makeLanguageSchema } from "@/core/graph/shared/domain/Language.js";
import { DifficultySchema } from "@/core/graph/shared/domain/Difficulty.js";
import { z } from "zod/v4";
import { UserInstructionsSchema } from "@/core/graph/shared/domain/UserInstructions.js";
import type { Config } from "@/core/graph/config.js";
import { LLMConfigSchema } from "@/core/graph/shared/domain/LLMConfig.js";
import { JobIdSchema } from "./JobId.js";
import { RunModeSchema } from "@/core/graph/shared/domain/RunMode.js";
import {
  isCanonicalShape,
  OutlineSegmentsSchema,
} from "@/core/graph/shared/outline/segments.js";

/**
 * Request schemas depend on configured `LANGUAGES` and global LLM (`config.llm`),
 * so built from resolved graph config (`GraphAppContext.config`), not module scope.
 */
function sharedFields(config: Config) {
  return {
    jobId: JobIdSchema.optional(),
    icd: ICDCodeSchema.optional().describe(
      "ICD-11 code: a stem code ('CA40.Z') or a post-coordinated cluster ('CA40.Z&XB22'). With " +
        "ICD configured ('ICD' in /api/features) it alone identifies the diagnosis and wins over " +
        "'diagnosis', and a cluster ICD rejects is a 400; without, it rides along unchecked."
    ),
    diagnosis: z
      .string()
      .optional()
      .describe(
        "Diagnosis name, in the request language. Required without ICD; with ICD it must match " +
          "an ICD-11 title or synonym exactly."
      ),
    generationFlags: z
      .array(GenerationFlagSchema)
      // `.min(1)` mirrors `CaseGenerationStateSchema`: `[]` is 400, not 500 from graph.
      .min(1, "generationFlags must name at least one field to generate")
      .default(AllGenerationFlags)
      .describe("Generation flags to specify case fields to generate"),
    // Checked against configured `LANGUAGES` here: unsupported language is 400, not 500.
    language: makeLanguageSchema(config.LANGUAGES)
      .default("en")
      .describe(
        `Language to generate the case in. One of: ${config.LANGUAGES.join(", ")}. Defaults to 'en'.`
      ),
    difficulty: DifficultySchema.optional().describe(
      "How unclear the diagnosis should be to a student working through the case. " +
        "'easy' features a clean, classic subset of symptoms with definitive procedure " +
        "results; 'medium' adds distractor symptoms from other diseases and minor/borderline " +
        "changes in procedure results; 'hard' presents an atypical case with omitted " +
        "hallmark symptoms and ambiguous procedure results. Defaults to 'medium'."
    ),
    llmConfig: LLMConfigSchema.optional().describe(
      "Optional per-request model selection for the LLM used in case " +
        "generation. Applies to all internal roles (generator/judge/" +
        "translator) uniformly — per-role overrides are not supported in " +
        "the request body."
    ),
  };
}

const index = z.number().int().min(0);
/** A procedure leaf: its catalogue `code`, or its `order` without one (freeform). */
const procedure = z.union([z.string(), index]);

/**
 * What to regenerate (#272), an array built and never parsed (a category
 * may contain any character). Outline: whole, or one section by the index
 * of its fixed heading segment in the plan. Field, unit (anamnesis category
 * as in the case, procedure `code` or `order`), part (index in the unit's parts).
 */
export const CasePathSchema = z.union([
  z.tuple([z.literal("outline")]),
  z.tuple([z.literal("outline"), index]),
  z.tuple([GenerationFlagSchema]),
  z.tuple([z.literal("chiefComplaint"), index]),
  z.tuple([z.literal("anamnesis"), z.string()]),
  z.tuple([z.literal("anamnesis"), z.string(), index]),
  z.tuple([z.literal("procedures"), procedure]),
  z.tuple([z.literal("procedures"), procedure, index]),
]);

export const RegenerateSchema = z.object({
  path: CasePathSchema,
  instruction: z
    .string()
    .min(1)
    .max(4_000)
    .optional()
    .describe(
      "Refine: what to change, in the request language. Absent: reroll, same inputs again."
    ),
  alts: z
    .array(z.string())
    .optional()
    .describe(
      "The target unit's current parts' `alt`, from the case. Required at unit and part depth."
    ),
});
export type Regenerate = z.infer<typeof RegenerateSchema>;

/** LLM rules shared by both shapes. */
function withLlmRules<T extends z.ZodType<{ llmConfig?: unknown }>>(
  schema: T,
  config: Config
) {
  return schema
    .refine((data) => !(data.llmConfig && config.llm), {
      message: "LLM config is not allowed when a global LLM is configured",
      path: ["llmConfig"],
    })
    .refine((data) => data.llmConfig || config.llm, {
      message: "LLM config is required when no global LLM is configured",
      path: ["llmConfig"],
    });
}

function makeShapes(config: Config, icd: boolean) {
  const { jobId, language, difficulty, llmConfig, ...firstOnly } =
    sharedFields(config);
  const firstCall = withLlmRules(
    z
      .object({
        jobId,
        language,
        difficulty,
        llmConfig,
        ...firstOnly,
        userInstructions: UserInstructionsSchema.optional().describe(
          "Additional context for case generation. Absorbed into the plan."
        ),
        mode: RunModeSchema.default("normal").describe(
          "'normal' generates the case end to end. 'plan' stops once the " +
            "plan exists and returns it in the request language; send its " +
            "`context` back (with the possibly edited `plan`) to generate " +
            "the case from it. Defaults to 'normal'."
        ),
        // `never`, not absent: lenient objects drop unknown keys, so without
        // it a continuation would parse here, lose its context and re-plan.
        context: z
          .never()
          .optional()
          .describe(
            "Not allowed on a first call: a body with `context` is a continuation."
          ),
        plan: z
          .never()
          .optional()
          .describe("Only on a continuation, next to its `context`."),
      })
      // ICD configured: a code alone resolves. Without ICD only a name does (#238).
      .refine((data) => (icd && data.icd) || data.diagnosis, {
        message: icd
          ? "Either 'icd' or 'diagnosis' must be provided"
          : "'diagnosis' is required: no ICD API is configured to resolve 'icd'",
        path: icd ? ["icd"] : ["diagnosis"],
      }),
    config
  );
  // Lenient: first-call fields sent with a context are dropped, never read:
  // the context carries the diagnosis, flags and the plan (#272).
  const continuation = withLlmRules(
    z.object({
      jobId,
      language,
      difficulty: difficulty.describe(
        "Overrides the difficulty of the first call, kept in `context`."
      ),
      llmConfig,
      context: z
        .string()
        .min(1)
        .describe(
          "Opaque generation context from the previous response, sent back " +
            "unchanged. Never read or built by a client."
        ),
      plan: OutlineSegmentsSchema.refine(isCanonicalShape, {
        message:
          "A plan must alternate editable and fixed segments, starting and ending with an editable one",
      })
        .optional()
        .describe(
          "Plan-mode review: the plan as returned, possibly edited. Fixed " +
            "segments must be unchanged. Absent: the context's plan is used."
        ),
      regenerate: z
        .array(RegenerateSchema)
        .min(1)
        .max(20)
        .optional()
        .describe(
          "Regenerate parts of the case or plan; entries run concurrently. " +
            "Absent (and no `accept`): generate the case from the plan."
        ),
      accept: z
        .array(GenerationFlagSchema)
        .min(1)
        .optional()
        .describe("Fields of the pending proposal to apply."),
    }),
    config
  );
  return { firstCall, continuation };
}

/**
 * First call or continuation. Exclusive by `context` (`never` on the first
 * call, required on the continuation), so a plain union picks the right one. A body
 * matching neither fails with one `invalid_union` issue, both branches' reasons
 * nested in it. Parser for both transports and the exported contract.
 */
export function makeCaseGenerationRequestSchema(
  config: Config,
  { icd }: { icd: boolean }
) {
  const { firstCall, continuation } = makeShapes(config, icd);
  return z.union([firstCall, continuation]);
}

export type CaseGenerationRequestSchema = ReturnType<
  typeof makeCaseGenerationRequestSchema
>;
type Shapes = ReturnType<typeof makeShapes>;
export type FirstCallRequest = z.output<Shapes["firstCall"]>;
export type ContinuationRequest = z.output<Shapes["continuation"]>;
export type CaseGenerationRequest = FirstCallRequest | ContinuationRequest;
