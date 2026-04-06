import {
  AllGenerationFlags,
  GenerationFlagSchema,
} from "@/extensions/core/models/GenerationFlags.js";
import { ICDCodeSchema } from "@/extensions/core/models/Diagnosis.js";
import { LanguageSchema } from "@/extensions/core/models/Language.js";
import { z } from "zod/v4";
import { UserInstructionsSchema } from "@/extensions/core/models/UserInstructions.js";
import { config } from "@/extensions/core/index.js";
import { LLMConfigSchema } from "@/extensions/core/models/LLMConfig.js";

export const CaseGenerationRequestSchema = z
  .object({
    icd: ICDCodeSchema.optional().describe(
      "ICD-10 code of the disease to generate a case for"
    ),
    diagnosis: z.string().optional().describe("Name of the disease diagnosis"),
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
    anamnesisCategories: z
      .array(z.string())
      .optional()
      .describe("Categories of anamnesis to include in the case"),
    llmConfig: LLMConfigSchema.optional().describe(
      "Optional configuration for the LLM used in case generation"
    ),
    traceId: z
      .string()
      .optional()
      .describe("Optional unique ID to track generation progress via SSE"),
  })
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

export type CaseGenerationRequest = z.infer<typeof CaseGenerationRequestSchema>;
