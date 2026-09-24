import z from "zod";
import { matchDiagnosis as matchDiagnosisGateway } from "@/core/graph/03aigateway/procedures.aigateway.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { PatientSchema } from "@/core/graph/models/Patient.js";
import type { Tool } from "@/core/graph/utils/tool.js";

// ─── Shared input types ───────────────────────────────────────────────────────

// Zod mirror of `Presentation` (03aigateway/procedures.aigateway.ts); also
// the blinded solver's child-graph state schema. Text projection, not domain
// shape: `presentationOf` builds it via `textOf`; bytes never reach a prompt.
export const PresentationSchema = z.object({
  patient: PatientSchema.optional(),
  chiefComplaint: z.string().optional(),
  anamnesis: z
    .array(z.object({ category: z.string(), answer: z.string() }))
    .optional(),
});

// ─── matchDiagnosis ───────────────────────────────────────────────────────────

const MatchDiagnosisInputSchema = z.object({
  proposedName: z.string(),
  diagnosis: DiagnosisSchema,
});

export const matchDiagnosisTool: Tool<
  z.infer<typeof MatchDiagnosisInputSchema>,
  boolean
> = {
  name: "match_diagnosis",
  description:
    "LLM judge: determine whether a proposed diagnosis name is equivalent to the true diagnosis, accounting for synonyms and alternative names.",
  inputSchema: MatchDiagnosisInputSchema,
  invoke: ({ proposedName, diagnosis }, runtime, context) =>
    matchDiagnosisGateway(runtime, proposedName, diagnosis, context),
};

// ─── Export ───────────────────────────────────────────────────────────────────

// `planProcedureResults` needs `ModalityProvider[]` (runtime port, not
// zod-validatable), so it is called directly, not as a `Tool`. Strategy
// adapters also call the aigateway directly.
export const procedureTools = {
  matchDiagnosis: matchDiagnosisTool,
} as const;
