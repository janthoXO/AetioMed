import { z } from "zod/v4";
import { AnamnesisCategory } from "../domain-models/Anamnesis.js";

const AnamnesisFieldSchema = z.object({
  category: z.enum(AnamnesisCategory),
  answer: z.string(),
});

export const CaseGenerationResponseSchema = z.object({
  treatmentReason: z.string().optional(),
  anamnesis: z.array(AnamnesisFieldSchema).optional(),
});

export type CaseGenerationResponse = z.infer<
  typeof CaseGenerationResponseSchema
>;
