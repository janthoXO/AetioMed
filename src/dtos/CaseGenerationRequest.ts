import {
  AllGenerationFlags,
  GenerationFlagsSchema,
} from "@/domain-models/GenerationFlags.js";
import { ICDCodeSchema } from "@/domain-models/ICD.js";
import { LanguageSchema } from "@/domain-models/Language.js";
import { z } from "zod/v4";

export const CaseGenerationRequestSchema = z
  .object({
    icd: ICDCodeSchema.optional().describe(
      "ICD-10 code of the disease to generate a case for"
    ),
    diagnosis: z.string().optional().describe("Name of the disease diagnosis"),
    context: z
      .string()
      .optional()
      .describe("Additional context for case generation"),
    generationFlags: z
      .array(GenerationFlagsSchema)
      .default(AllGenerationFlags)
      .describe("Generation flags to specify case fields to generate"),
    language: LanguageSchema.optional().describe(
      "Language to generate the case in"
    ),
    anamnesisCategories: z
      .array(z.string())
      .optional()
      .describe("Categories of anamnesis to include in the case"),
  })
  .refine((data) => data.icd || data.diagnosis, {
    message: "Either 'icd' or 'diagnosis' must be provided",
    path: ["icd"],
  });

export type CaseGenerationRequest = z.infer<typeof CaseGenerationRequestSchema>;
