import z from "zod";
import {
  generateProcedureResults,
  matchDiagnosis as matchDiagnosisGateway,
} from "@/core/graph/03aigateway/procedures.aigateway.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { PatientSchema } from "@/core/graph/models/Patient.js";
import { ChiefComplaintSchema } from "@/core/graph/models/ChiefComplaint.js";
import { AnamnesisSchema } from "@/core/graph/models/Anamnesis.js";
import {
  ProcedureSchema,
  type ProcedureResult,
} from "@/core/graph/models/Procedure.js";
import type { Tool } from "@/core/graph/utils/tool.js";

// ─── Shared input types ───────────────────────────────────────────────────────

// Mirrors the `Presentation` type (03aigateway/procedures.aigateway.ts) as a
// Zod schema — used here for tool-input validation, and reused by
// `03procedure/index.ts` as the blinded solver's child-graph state schema
// (both need the exact same shape). `zod` and `zod/v4` are the same v4
// package's default-export and subpath-export forms of the same schemas —
// not a version mismatch — so composing `AnamnesisSchema` (imported via
// `zod/v4`) here works exactly as it does in `models/Case.ts`.
export const PresentationSchema = z.object({
  patient: PatientSchema.optional(),
  chiefComplaint: ChiefComplaintSchema.optional(),
  anamnesis: AnamnesisSchema.optional(),
});

// ─── generateProcedureResults ─────────────────────────────────────────────────

const GenerateProcedureResultsInputSchema = z.object({
  presentation: PresentationSchema,
  diagnosis: DiagnosisSchema,
  procedureSteps: z.array(ProcedureSchema),
  outline: z.string().optional(),
  userInstructions: z.string().optional(),
});

export const generateProcedureResultsTool: Tool<
  z.infer<typeof GenerateProcedureResultsInputSchema>,
  ProcedureResult[]
> = {
  name: "generate_procedure_results",
  description:
    "Non-blinded result step: generate clinically realistic results for a batch of concurrently-scheduled procedures, consistent with the true diagnosis and the case blueprint's difficulty strategy.",
  inputSchema: GenerateProcedureResultsInputSchema,
  invoke: (
    { presentation, diagnosis, procedureSteps, outline, userInstructions },
    runtime,
    context
  ) =>
    generateProcedureResults(
      runtime,
      presentation,
      diagnosis,
      procedureSteps,
      outline,
      userInstructions,
      context
    ),
};

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

export type { ProcedureResult };

// Both tools are oracle-side (they see the true diagnosis) and
// strategy-independent — every other procedure tool has been folded into the
// `ProcedureStrategy` adapters (`strategy/directPick.ts`,
// `strategy/categoryScopedPick.ts`), which call the aigateway functions
// directly instead of going through a `Tool` wrapper. See issue 07's spec §4.
export const procedureTools = {
  generateProcedureResults: generateProcedureResultsTool,
  matchDiagnosis: matchDiagnosisTool,
} as const;
