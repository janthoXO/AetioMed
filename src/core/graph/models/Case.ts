import { z } from "zod/v4";
import {
  AnamnesisSchema,
  buildAnamnesisSchema,
  type AnamnesisCategory,
} from "./Anamnesis.js";
import { ChiefComplaintSchema } from "./ChiefComplaint.js";
import { ProcedureResultSchema } from "./Procedure.js";
import { PatientSchema } from "./Patient.js";

/**
 * Zod schema for a complete medical case
 */
export const CaseSchema = z.object({
  patient: PatientSchema.optional(),
  chiefComplaint: ChiefComplaintSchema.optional(),
  anamnesis: AnamnesisSchema.optional(),
  procedures: z.array(ProcedureResultSchema).optional(),
});

export type Case = z.infer<typeof CaseSchema>;

/**
 * Schema for fixing case inconsistencies. Procedures are generated in a
 * later phase (after inconsistency fixing runs), so they are intentionally
 * omitted here — see `fixCaseInconsistencies`.
 */
export function buildCaseSchema(anamnesisCategories?: AnamnesisCategory[]) {
  return z.object({
    patient: PatientSchema.optional(),
    chiefComplaint: ChiefComplaintSchema.optional(),
    anamnesis: buildAnamnesisSchema(anamnesisCategories).optional(),
  });
}
