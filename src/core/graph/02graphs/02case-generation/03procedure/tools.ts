import z from "zod";
import { matchDiagnosis as matchDiagnosisGateway } from "@/core/graph/03aigateway/procedures.aigateway.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { PatientSchema } from "@/core/graph/models/Patient.js";
import type { Tool } from "@/core/graph/utils/tool.js";

// ─── Shared input types ───────────────────────────────────────────────────────

// Mirrors the `Presentation` type (03aigateway/procedures.aigateway.ts) as a
// Zod schema — used here for tool-input validation, and reused by
// `03procedure/index.ts` as the blinded solver's child-graph state schema
// (both need the exact same shape). This is a **text projection**, not the
// domain `ChiefComplaint`/`Anamnesis` shape: `presentationOf`
// (`03procedure/index.ts`) builds it from the domain `Case` via `textOf`
// (issue 11 §4) — bytes must never reach a prompt, so this schema's fields
// are `string`, never `ContentPart[]`.
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

// The last remaining `Tool` here (issue 21 §7): `planProcedureResults` needs
// a field's `ModalityProvider[]`, which is a runtime port, not zod-validatable
// data — the same reason the presentation fields' planner gateways
// (`planChiefComplaint`, `planAnamnesis`) are called directly from their
// graph nodes rather than wrapped as `Tool`s. `03procedure/index.ts` calls
// `planProcedureResults` directly for the same reason; every other procedure
// tool has already been folded into the `ProcedureStrategy` adapters
// (`strategy/directPick.ts`, `strategy/categoryScopedPick.ts`), which call
// the aigateway functions directly too. See issue 07's spec §4.
export const procedureTools = {
  matchDiagnosis: matchDiagnosisTool,
} as const;
