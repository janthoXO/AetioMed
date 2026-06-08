import { z } from "zod/v4";
import {
  AnamnesisSchema,
  buildAnamnesisSchema,
  type AnamnesisCategory,
} from "./Anamnesis.js";
import { ChiefComplaintSchema } from "./ChiefComplaint.js";
import {
  ProcedureSchema,
  buildProcedureSchema,
  type ProcedureName,
} from "./Procedure.js";
import { PatientSchema } from "./Patient.js";

/**
 * Zod schema for a complete medical case
 */
export const CaseSchema = z.object({
  patient: PatientSchema.optional(),
  chiefComplaint: ChiefComplaintSchema.optional(),
  anamnesis: AnamnesisSchema.optional(),
  procedures: z.array(ProcedureSchema).optional(),
});

export type Case = z.infer<typeof CaseSchema>;

export function buildCaseSchema(
  anamnesisCategories?: AnamnesisCategory[],
  procedureNames?: ProcedureName[]
) {
  return z.object({
    patient: PatientSchema.optional(),
    chiefComplaint: ChiefComplaintSchema.optional(),
    anamnesis: buildAnamnesisSchema(anamnesisCategories).optional(),
    procedures: z.array(buildProcedureSchema(procedureNames)).optional(),
  });
}
