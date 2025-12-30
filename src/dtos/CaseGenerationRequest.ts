import { z } from "zod/v4";
import { GenerationFlagKeys } from "@/domain-models/GenerationFlags.js";

export const CaseGenerationRequestSchema = z.object({
  diagnosis: z.string(),
  context: z.string().optional(),
  generationFlags: z.array(z.enum(GenerationFlagKeys)).default(["All"]),
});

export type CaseGenerationRequest = z.infer<typeof CaseGenerationRequestSchema>;
