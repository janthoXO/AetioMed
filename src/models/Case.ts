import { z } from "zod/v4";
import { AnamnesisJsonExampleString, AnamnesisSchema } from "./Anamnesis.js";
import {
  ChiefComplaintExample,
  ChiefComplaintSchema,
} from "./ChiefComplaint.js";
import { AllGenerationFlags, type GenerationFlag } from "./GenerationFlags.js";
import {
  ProcedureArrayJsonExampleString,
  ProcedureSchema,
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
