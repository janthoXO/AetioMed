import { z } from "zod/v4";
import { AnamnesisSchema } from "./Anamnesis.js";
import { ChiefComplaintSchema } from "./ChiefComplaint.js";

/**
 * Zod schema for a complete medical case
 */
export const CaseSchema = z.object({
  chiefComplaint: ChiefComplaintSchema.optional(),
  anamnesis: AnamnesisSchema.optional(),
});

export type Case = z.infer<typeof CaseSchema>;
