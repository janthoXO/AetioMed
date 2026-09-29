import { z } from "zod/v4";
import { AnamnesisSchema } from "./Anamnesis.js";
import { ChiefComplaintSchema } from "./ChiefComplaint.js";
import { ProcedureResultSchema } from "./Procedure.js";
import { procedureTreeSchema } from "./ProcedureTree.js";
import { PatientSchema } from "./Patient.js";

/**
 * Domain shape (response body via `src/api/contentWire.ts`, translation I/O),
 * **not** an LLM output schema: `ContentPart[]` fields are never LLM-emitted.
 * Generators emit plans (`z.string()`-based), never parts; see `modality/`.
 */
export const CaseSchema = z.object({
  patient: PatientSchema.optional(),
  chiefComplaint: ChiefComplaintSchema.optional(),
  anamnesis: AnamnesisSchema.optional(),
  procedures: procedureTreeSchema(ProcedureResultSchema).optional(),
});

export type Case = z.infer<typeof CaseSchema>;
