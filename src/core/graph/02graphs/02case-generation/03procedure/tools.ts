import z from "zod";
import {
  generateBlindedProcedureStep,
  generateProcedureResult,
  generateDiagnosisBridge,
  matchDiagnosis as matchDiagnosisGateway,
  type BlindedProcedureStepResult,
} from "@/core/graph/03aigateway/procedureSolver.aigateway.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { PatientSchema } from "@/core/graph/models/Patient.js";
import {
  ProcedureSchema,
  ProcedureStepSchema,
  ProcedureNameSchema,
  type Procedure,
  type ProcedureStep,
} from "@/core/graph/models/Procedure.js";
import type { Tool } from "@/core/graph/utils/tool.js";

// ─── Shared input types ───────────────────────────────────────────────────────

// Inlined to avoid importing AnamnesisSchema (zod/v4) into a zod v3 file.
const PresentationSchema = z.object({
  patient: PatientSchema.optional(),
  chiefComplaint: z.string().optional(),
  anamnesis: z
    .array(z.object({ category: z.string(), answer: z.string() }))
    .optional(),
});

// ─── generateBlindedProcedureStep ────────────────────────────────────────────

const GenerateBlindedProcedureStepInputSchema = z.object({
  presentation: PresentationSchema,
  previousProcedures: z.array(ProcedureSchema).default([]),
  ruledOutDiagnoses: z.array(z.string()).default([]),
  procedureNameList: z.array(ProcedureNameSchema).optional(),
  userInstructions: z.string().optional(),
});

export const generateBlindedProcedureStepTool: Tool<
  z.infer<typeof GenerateBlindedProcedureStepInputSchema>,
  BlindedProcedureStepResult
> = {
  name: "generate_blinded_procedure_step",
  description:
    "Blinded solver step: choose the next procedure to order or commit to a diagnosis, without knowledge of the true diagnosis.",
  inputSchema: GenerateBlindedProcedureStepInputSchema,
  invoke: (
    {
      presentation,
      previousProcedures,
      ruledOutDiagnoses,
      procedureNameList,
      userInstructions,
    },
    context
  ) =>
    generateBlindedProcedureStep(
      presentation,
      previousProcedures,
      ruledOutDiagnoses,
      procedureNameList,
      userInstructions,
      context
    ),
};

// ─── generateProcedureResult ──────────────────────────────────────────────────

const GenerateProcedureResultInputSchema = z.object({
  presentation: PresentationSchema,
  diagnosis: DiagnosisSchema,
  procedureStep: ProcedureStepSchema,
  userInstructions: z.string().optional(),
});

export const generateProcedureResultTool: Tool<
  z.infer<typeof GenerateProcedureResultInputSchema>,
  string
> = {
  name: "generate_procedure_result",
  description:
    "Non-blinded result step: generate a clinically realistic result for a procedure, consistent with the true diagnosis.",
  inputSchema: GenerateProcedureResultInputSchema,
  invoke: ({ presentation, diagnosis, procedureStep, userInstructions }, context) =>
    generateProcedureResult(
      presentation,
      diagnosis,
      procedureStep,
      userInstructions,
      context
    ),
};

// ─── generateDiagnosisBridge ──────────────────────────────────────────────────

const GenerateDiagnosisBridgeInputSchema = z.object({
  presentation: PresentationSchema,
  diagnosis: DiagnosisSchema,
  previousProcedures: z.array(ProcedureSchema).default([]),
  procedureNameList: z.array(ProcedureNameSchema).optional(),
  userInstructions: z.string().optional(),
});

export const generateDiagnosisBridgeTool: Tool<
  z.infer<typeof GenerateDiagnosisBridgeInputSchema>,
  Procedure[]
> = {
  name: "generate_diagnosis_bridge",
  description:
    "Non-blinded bridge step: generate the remaining confirmatory procedures (with results) that complete the diagnostic pathway to the true diagnosis.",
  inputSchema: GenerateDiagnosisBridgeInputSchema,
  invoke: (
    { presentation, diagnosis, previousProcedures, procedureNameList, userInstructions },
    context
  ) =>
    generateDiagnosisBridge(
      presentation,
      diagnosis,
      previousProcedures,
      procedureNameList,
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
  invoke: ({ proposedName, diagnosis }, context) =>
    matchDiagnosisGateway(proposedName, diagnosis, context),
};

// ─── Export ───────────────────────────────────────────────────────────────────

export type { ProcedureStep };

export const procedureTools = {
  generateBlindedProcedureStep: generateBlindedProcedureStepTool,
  generateProcedureResult: generateProcedureResultTool,
  generateDiagnosisBridge: generateDiagnosisBridgeTool,
  matchDiagnosis: matchDiagnosisTool,
} as const;
