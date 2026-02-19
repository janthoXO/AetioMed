import { z } from "zod/v4";
import { AnamnesisJsonExampleString, AnamnesisSchema } from "./Anamnesis.js";
import {
  ChiefComplaintExample,
  ChiefComplaintSchema,
} from "./ChiefComplaint.js";
import { AllGenerationFlags, type GenerationFlag } from "./GenerationFlags.js";
import {
  ProcedureWithRelevanceArrayJsonExampleString,
  ProcedureWithRelevanceSchema,
} from "./Procedure.js";

/**
 * Zod schema for a complete medical case
 */
export const CaseSchema = z.object({
  chiefComplaint: ChiefComplaintSchema.optional(),
  anamnesis: AnamnesisSchema.optional(),
  procedures: z.array(ProcedureWithRelevanceSchema).optional(),
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
          return `procedures: ${ProcedureWithRelevanceArrayJsonExampleString()}`;
        default:
          return "";
      }
    })
    .join(",\n")}}`;
}
