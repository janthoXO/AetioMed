import { z } from "zod/v4";
import {
  AnamnesisJsonExampleString,
  AnamnesisSchema,
  buildAnamnesisSchema,
  type AnamnesisCategory,
} from "./Anamnesis.js";
import {
  ChiefComplaintExample,
  ChiefComplaintSchema,
} from "./ChiefComplaint.js";
import { AllGenerationFlags, type GenerationFlag } from "./GenerationFlags.js";
import {
  ProcedureArrayJsonExampleString,
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

export function CaseJsonExampleString(
  generationFlags: GenerationFlag[] = AllGenerationFlags
): string {
  return `{${generationFlags
    .map((flag) => {
      switch (flag) {
        case "chiefComplaint":
          return `chiefComplaint: ${ChiefComplaintExample()}`;
        case "anamnesis":
          return `anamnesis: ${AnamnesisJsonExampleString()}`;
        case "procedures":
          return `procedures: ${ProcedureArrayJsonExampleString()}`;
        default:
          return "";
      }
    })
    .join(",\n")}}`;
}
