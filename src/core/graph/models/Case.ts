import { z } from "zod/v4";
import { AnamnesisSchema } from "./Anamnesis.js";
import { ChiefComplaintSchema } from "./ChiefComplaint.js";
import { ProcedureResultSchema } from "./Procedure.js";
import { PatientSchema } from "./Patient.js";

/**
 * Zod schema for a complete medical case. Domain shape: HTTP response body
 * (via the wire codec, `src/api/contentWire.ts`), persistence payload, and
 * translation I/O — **not** an LLM output schema. `chiefComplaint`,
 * `anamnesis[].answer` and `procedures[].result` are `ContentPart[]`
 * (issue 11), which an LLM must never be asked to emit; field generators
 * produce plain strings under their own `z.string()`-based schemas instead
 * (see e.g. `ChiefComplaintJsonSchema`, `buildAnamnesisSchema`,
 * `ProcedureResultTextSchema`) and the gateway wraps them with `textPart()`.
 */
export const CaseSchema = z.object({
  patient: PatientSchema.optional(),
  chiefComplaint: ChiefComplaintSchema.optional(),
  anamnesis: AnamnesisSchema.optional(),
  procedures: z.array(ProcedureResultSchema).optional(),
});

export type Case = z.infer<typeof CaseSchema>;
