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

/**
 * The public request schema depends on the deployment's configured
 * `LANGUAGES` set (issue 09 §1) as well as on whether a global LLM is
 * configured (`config.llm`), so it can no longer be a module-scope constant
 * evaluated at import time — that only worked "by luck of load order"
 * against the mutable graph-config singleton this replaces, which could be
 * `undefined` depending on import order. Build it explicitly from the
 * resolved graph config instead: `app.ts` resolves it once and hands it to
 * each transport's start function as `GraphAppContext.config`, and callers
 * (the `rest`/`nats` transports) call this with that value.
 */
function makeBaseCaseGenerationRequestSchema(config: Config) {
  return z.object({
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
      // `.min(1)` mirrors `CaseGenerationStateSchema`, which already declares
      // it — without it here an explicit `[]` passed the API and then threw a
      // Zod error deep inside the graph, surfacing as a 500 rather than a 400.
      .min(1, "generationFlags must name at least one field to generate")
      .default(AllGenerationFlags)
      .describe("Generation flags to specify case fields to generate"),
    // Validated against the deployment's configured `LANGUAGES` here, at the
    // API boundary, so an unsupported language is a 400 — not a 500 raised
    // deep inside the graph (issue 09 §1).
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
    llmConfig: LLMConfigSchema.optional().describe(
      "Optional configuration for the LLM used in case generation. Applies to " +
        "all internal roles (generator/judge/translator) uniformly — per-role " +
        "overrides are not supported in the request body. `temperature` is " +
        "accepted for schema compatibility but is overridden by the call " +
        "site's fixed temperature class; it has no effect."
    ),
  });
}

export function makeCaseGenerationRequestSchema(config: Config) {
  return makeBaseCaseGenerationRequestSchema(config)
    .refine((data) => data.icd || data.diagnosis, {
      message: "Either 'icd' or 'diagnosis' must be provided",
      path: ["icd"],
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
