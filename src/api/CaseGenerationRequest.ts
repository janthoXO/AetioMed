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
 * Request schema depends on configured `LANGUAGES` and global LLM (`config.llm`),
 * so built from resolved graph config (`GraphAppContext.config`), not module scope.
 */
function makeBaseCaseGenerationRequestSchema(config: Config) {
  return z.object({
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
    userInstructions: UserInstructionsSchema.optional().describe(
      "Additional context for case generation. Absorbed into the plan: ignored when 'plan' is set."
    ),
    generationFlags: z
      .array(GenerationFlagSchema)
      // `.min(1)` mirrors `CaseGenerationStateSchema`: `[]` is 400, not 500 from graph.
      .min(1, "generationFlags must name at least one field to generate")
      .default(AllGenerationFlags)
      .describe("Generation flags to specify case fields to generate"),
    // Checked against configured `LANGUAGES` here: unsupported language is 400, not 500.
    language: makeLanguageSchema(config.LANGUAGES)
      .optional()
      .describe(
        `Language to generate the case in. One of: ${config.LANGUAGES.join(", ")}.`
      ),
    difficulty: DifficultySchema.optional().describe(
      "How unclear the diagnosis should be to a student working through the case. " +
        "'easy' features a clean, classic subset of symptoms with definitive procedure " +
        "results; 'medium' adds distractor symptoms from other diseases and minor/borderline " +
        "changes in procedure results; 'hard' presents an atypical case with omitted " +
        "hallmark symptoms and ambiguous procedure results. Defaults to 'medium'."
    ),
    mode: RunModeSchema.default("normal").describe(
      "'normal' generates the case end to end and hands over its (English) " +
        "plan on the way. 'plan' stops once the plan exists and returns it " +
        "in the request language; send the same request back with `plan` " +
        "to generate the case from it."
    ),
    plan: OutlineSegmentsSchema.optional().describe(
      "A plan from an earlier call with this request, possibly " +
        "edited: planning is skipped and the case is generated from it. In " +
        "plan mode it is in the request language, in normal mode English — " +
        "exactly as it was handed out. Fixed segments must be unchanged."
    ),
    llmConfig: LLMConfigSchema.optional().describe(
      "Optional per-request model selection for the LLM used in case " +
        "generation. Applies to all internal roles (generator/judge/" +
        "translator) uniformly — per-role overrides are not supported in " +
        "the request body."
    ),
  });
}

export function makeCaseGenerationRequestSchema(config: Config) {
  return (
    makeBaseCaseGenerationRequestSchema(config)
      // ICD configured: a code alone resolves. Without ICD only a name does (#238).
      .refine((data) => (config.ICD_API_URL && data.icd) || data.diagnosis, {
        message: config.ICD_API_URL
          ? "Either 'icd' or 'diagnosis' must be provided"
          : "'diagnosis' is required: no ICD API is configured to resolve 'icd'",
        path: config.ICD_API_URL ? ["icd"] : ["diagnosis"],
      })
      .refine((data) => !data.plan || isCanonicalShape(data.plan), {
        message:
          "A plan must alternate editable and fixed segments, starting and ending with an editable one",
        path: ["plan"],
      })
      .refine((data) => !(data.llmConfig && config.llm), {
        message: "LLM config is not allowed when a global LLM is configured",
        path: ["llmConfig"],
      })
      .refine((data) => data.llmConfig || config.llm, {
        message: "LLM config is required when no global LLM is configured",
        path: ["llmConfig"],
      })
  );
}

export type CaseGenerationRequestSchema = ReturnType<
  typeof makeCaseGenerationRequestSchema
>;
export type CaseGenerationRequest = z.infer<
  ReturnType<typeof makeBaseCaseGenerationRequestSchema>
>;
