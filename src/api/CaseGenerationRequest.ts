import {
  AllGenerationFlags,
  GenerationFlagSchema,
} from "@/core/graph/models/GenerationFlags.js";
import { ICDCodeSchema } from "@/core/graph/models/Diagnosis.js";
import { LanguageSchema } from "@/core/graph/models/Language.js";
import { DifficultySchema } from "@/core/graph/models/Difficulty.js";
import { z } from "zod/v4";
import { UserInstructionsSchema } from "@/core/graph/models/UserInstructions.js";
import type { Config } from "@/core/graph/config.js";
import { LLMConfigSchema } from "@/core/graph/models/LLMConfig.js";

const BaseCaseGenerationRequestSchema = z.object({
  icd: ICDCodeSchema.optional().describe(
    "ICD-11 code of the diagnosis to generate a case for"
  ),
  diagnosis: z.string().optional().describe("Name of the diagnosis diagnosis"),
  userInstructions: UserInstructionsSchema.optional().describe(
    "Additional context for case generation"
  ),
  generationFlags: z
    .array(GenerationFlagSchema)
    .default(AllGenerationFlags)
    .describe("Generation flags to specify case fields to generate"),
  language: LanguageSchema.optional().describe(
    "Language to generate the case in"
  ),
  difficulty: DifficultySchema.optional().describe(
    "How unclear the diagnosis should be to a student working through the case. " +
      "'easy' features a clean, classic subset of symptoms with definitive procedure " +
      "results; 'medium' adds distractor symptoms from other diseases and minor/borderline " +
      "changes in procedure results; 'hard' presents an atypical case with omitted " +
      "hallmark symptoms and ambiguous procedure results. Defaults to 'medium'."
  ),
  llmConfig: LLMConfigSchema.optional().describe(
    "Optional configuration for the LLM used in case generation. Applies to " +
      "all internal roles (generator/judge/translator) uniformly — per-role " +
      "overrides are not supported in the request body. `temperature` is " +
      "accepted for schema compatibility but is overridden by the call " +
      "site's fixed temperature class; it has no effect."
  ),
});

/**
 * The public request schema depends on whether a global LLM is configured
 * (`config.llm`), so it can no longer be a module-scope constant evaluated
 * at import time — that only worked "by luck of load order" against the
 * mutable graph-config singleton this replaces, which could be `undefined`
 * depending on import order. Build it explicitly from the resolved graph
 * config instead: `app.ts` resolves it once and hands it to each transport's
 * start function as `GraphAppContext.config`, and callers (the `rest`/`nats`
 * transports) call this with that value.
 */
export function makeCaseGenerationRequestSchema(config: Config) {
  return BaseCaseGenerationRequestSchema.refine(
    (data) => data.icd || data.diagnosis,
    {
      message: "Either 'icd' or 'diagnosis' must be provided",
      path: ["icd"],
    }
  )
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
  typeof BaseCaseGenerationRequestSchema
>;
