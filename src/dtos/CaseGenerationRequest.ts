import {
  AllGenerationFlags,
  GenerationFlagsSchema,
} from "@/domain-models/GenerationFlags.js";
import { z } from "zod/v4";

export const CaseGenerationRequestSchema = z.object({
  diagnosis: z.string(),
  context: z.string().optional().default(""),
  generationFlags: z.array(GenerationFlagsSchema).default(AllGenerationFlags),
});

export type CaseGenerationRequest = z.infer<typeof CaseGenerationRequestSchema>;
