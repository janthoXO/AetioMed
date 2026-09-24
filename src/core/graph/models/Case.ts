import { z } from "zod/v4";
import { AnamnesisSchema } from "./Anamnesis.js";
import { ChiefComplaintSchema } from "./ChiefComplaint.js";
import { ProcedureResultSchema } from "./Procedure.js";
import { PatientSchema } from "./Patient.js";

/**
 * Domain shape (response body via `src/api/contentWire.ts`, translation I/O),
 * **not** an LLM output schema: `ContentPart[]` fields are never LLM-emitted.
 * Generators use `z.string()` schemas (`ChiefComplaintJsonSchema`,
 * `buildAnamnesisSchema`, `ProcedureResultTextSchema`); gateway wraps into parts.
 */
export const CaseSchema = z.object({
  patient: PatientSchema.optional(),
  chiefComplaint: ChiefComplaintSchema.optional(),
  anamnesis: AnamnesisSchema.optional(),
  procedures: z.array(ProcedureResultSchema).optional(),
});

export type Case = z.infer<typeof CaseSchema>;
