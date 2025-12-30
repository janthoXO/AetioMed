import { z } from "zod/v4";
import { AnamnesisSchema } from "./Anamnesis.js";
import { ChiefComplaintSchema } from "./ChiefComplaint.js";

/**
 * Zod schema for a complete medical case
 */
export const CaseSchema = z.object({
  chiefComplaint: ChiefComplaintSchema,
  anamnesis: AnamnesisSchema,
});

export type Case = z.infer<typeof CaseSchema>;
