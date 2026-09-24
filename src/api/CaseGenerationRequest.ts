import {
  AllGenerationFlags,
  GenerationFlagSchema,
} from "@/core/graph/models/GenerationFlags.js";
import { ICDCodeSchema } from "@/core/graph/models/Diagnosis.js";
import { makeLanguageSchema } from "@/core/graph/models/Language.js";
import { DifficultySchema } from "@/core/graph/models/Difficulty.js";
import { z } from "zod/v4";
import { UserInstructionsSchema } from "@/core/graph/models/UserInstructions.js";
import type { Config } from "@/core/graph/config.js";
import { LLMConfigSchema } from "@/core/graph/models/LLMConfig.js";
import { JobIdSchema } from "./JobId.js";
import { RunModeSchema } from "@/core/graph/models/RunMode.js";
import {
  isCanonicalShape,
  OutlineSegmentsSchema,
} from "@/core/graph/outline/segments.js";

/**
 * Request schema depends on configured `LANGUAGES` and global LLM (`config.llm`),
 * so built from resolved graph config (`GraphAppContext.config`), not module scope.
 */
function makeBaseCaseGenerationRequestSchema(config: Config) {
  return z.object({
    jobId: JobIdSchema.optional(),
    icd: ICDCodeSchema.optional().describe(
      "ICD-11 code of the diagnosis to generate a case for"
    ),
    diagnosis: z
      .string()
      .optional()
      .describe("Name of the diagnosis diagnosis"),
    userInstructions: UserInstructionsSchema.optional().describe(
      "Additional context for case generation"
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
  return makeBaseCaseGenerationRequestSchema(config)
    .refine((data) => data.icd || data.diagnosis, {
      message: "Either 'icd' or 'diagnosis' must be provided",
      path: ["icd"],
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
    });
}

export type CaseGenerationRequestSchema = ReturnType<
  typeof makeCaseGenerationRequestSchema
>;
export type CaseGenerationRequest = z.infer<
  ReturnType<typeof makeBaseCaseGenerationRequestSchema>
>;
