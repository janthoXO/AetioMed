import z from "zod";
import { PatientSchema } from "@/core/graph/shared/domain/Patient.js";

// Zod mirror of `Presentation` (`prompt.ts`); also
// the blinded solver's child-graph state schema. Text projection, not domain
// shape: `presentationOf` builds it via `altOf`; bytes never reach a prompt.
export const PresentationSchema = z.object({
  patient: PatientSchema.optional(),
  chiefComplaint: z.string().optional(),
  anamnesis: z
    .array(z.object({ category: z.string(), answer: z.string() }))
    .optional(),
});
