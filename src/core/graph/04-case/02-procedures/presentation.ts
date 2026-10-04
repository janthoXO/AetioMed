import z from "zod";
import { PatientSchema } from "@/core/graph/shared/domain/Patient.js";

// Zod mirror of `Presentation` (`prompt.ts`); also
// the blinded solver's child-graph state schema. Text projection, not domain
// shape: `presentationOf` builds it via `altOf` or from outline sections; bytes
// never reach a prompt.
export const PresentationSchema = z.object({
  patient: z.union([PatientSchema, z.string()]).optional(),
  chiefComplaint: z.string().optional(),
  anamnesis: z
    .union([
      z.array(z.object({ category: z.string(), answer: z.string() })),
      z.string(),
    ])
    .optional(),
});
