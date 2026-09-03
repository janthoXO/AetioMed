import z from "zod";
import {
  generateBlindedProcedureStep,
  generateBlindedCategoryStep,
  generateBlindedProcedureStepFromCategories,
  generateProcedureResults,
  generateDiagnosisBridge,
  generateBridgeCategoryStep,
  generateBridgeProcedureStepFromCategories,
  matchDiagnosis as matchDiagnosisGateway,
  type BlindedProcedureStepResult,
  type BlindedCategoryStepResult,
  type ScopedProcedurePickResult,
} from "@/core/graph/03aigateway/procedures.aigateway.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { PatientSchema } from "@/core/graph/models/Patient.js";
import {
  ProcedureSchema,
  ProcedureResultSchema,
  type ProcedureResult,
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
  previousProcedures: z.array(ProcedureResultSchema).default([]),
  ruledOutDiagnoses: z.array(z.string()).default([]),
  userInstructions: z.string().optional(),
  iterationsRemaining: z.number().optional(),
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
      userInstructions,
      iterationsRemaining,
    },
    context
  ) =>
    generateBlindedProcedureStep(
      presentation,
      previousProcedures,
      ruledOutDiagnoses,
      userInstructions,
      iterationsRemaining,
      context
    ),
};

// ─── generateBlindedCategoryStep (LLM_SMALL: step 1 of 2) ────────────────────

const GenerateBlindedCategoryStepInputSchema = z.object({
  presentation: PresentationSchema,
  previousProcedures: z.array(ProcedureResultSchema).default([]),
  ruledOutDiagnoses: z.array(z.string()).default([]),
  userInstructions: z.string().optional(),
  iterationsRemaining: z.number().optional(),
});

export const generateBlindedCategoryStepTool: Tool<
  z.infer<typeof GenerateBlindedCategoryStepInputSchema>,
  BlindedCategoryStepResult
> = {
  name: "generate_blinded_category_step",
  description:
    "LLM_SMALL step 1 of 2: choose the plausibly-relevant procedure categories (over-inclusive) or commit to a diagnosis, without knowledge of the true diagnosis.",
  inputSchema: GenerateBlindedCategoryStepInputSchema,
  invoke: (
    {
      presentation,
      previousProcedures,
      ruledOutDiagnoses,
      userInstructions,
      iterationsRemaining,
    },
    context
  ) =>
    generateBlindedCategoryStep(
      presentation,
      previousProcedures,
      ruledOutDiagnoses,
      userInstructions,
      iterationsRemaining,
      context
    ),
};

// ─── generateBlindedProcedureStepFromCategories (LLM_SMALL: step 2 of 2) ─────

const GenerateBlindedProcedureStepFromCategoriesInputSchema = z.object({
  presentation: PresentationSchema,
  previousProcedures: z.array(ProcedureResultSchema).default([]),
  selectedCategories: z.array(z.string()).default([]),
  expandableCategories: z.array(z.string()).default([]),
  userInstructions: z.string().optional(),
});

export const generateBlindedProcedureStepFromCategoriesTool: Tool<
  z.infer<typeof GenerateBlindedProcedureStepFromCategoriesInputSchema>,
  ScopedProcedurePickResult
> = {
  name: "generate_blinded_procedure_step_from_categories",
  description:
    "LLM_SMALL step 2 of 2: choose the next batch of procedures from within the categories chosen in step 1 (plus any uncategorized procedures), without knowledge of the true diagnosis — or request additional categories to be pulled into scope (expand action, restricted to the given expandable categories).",
  inputSchema: GenerateBlindedProcedureStepFromCategoriesInputSchema,
  invoke: (
    {
      presentation,
      previousProcedures,
      selectedCategories,
      expandableCategories,
      userInstructions,
    },
    context
  ) =>
    generateBlindedProcedureStepFromCategories(
      presentation,
      previousProcedures,
      selectedCategories,
      expandableCategories,
      userInstructions,
      context
    ),
};

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
    context
  ) =>
    generateProcedureResults(
      presentation,
      diagnosis,
      procedureSteps,
      outline,
      userInstructions,
      context
    ),
};

// ─── generateDiagnosisBridge ──────────────────────────────────────────────────

const GenerateDiagnosisBridgeInputSchema = z.object({
  presentation: PresentationSchema,
  diagnosis: DiagnosisSchema,
  previousProcedures: z.array(ProcedureResultSchema).default([]),
  userInstructions: z.string().optional(),
});

export const generateDiagnosisBridgeTool: Tool<
  z.infer<typeof GenerateDiagnosisBridgeInputSchema>,
  ProcedureResult[]
> = {
  name: "generate_diagnosis_bridge",
  description:
    "Non-blinded bridge step: generate the remaining confirmatory procedures (with results) that complete the diagnostic pathway to the true diagnosis.",
  inputSchema: GenerateDiagnosisBridgeInputSchema,
  invoke: (
    { presentation, diagnosis, previousProcedures, userInstructions },
    context
  ) =>
    generateDiagnosisBridge(
      presentation,
      diagnosis,
      previousProcedures,
      userInstructions,
      context
    ),
};

// ─── generateBridgeCategoryStep (LLM_SMALL: bridge step 1 of 2) ──────────────

const GenerateBridgeCategoryStepInputSchema = z.object({
  presentation: PresentationSchema,
  diagnosis: DiagnosisSchema,
  previousProcedures: z.array(ProcedureResultSchema).default([]),
  userInstructions: z.string().optional(),
});

export const generateBridgeCategoryStepTool: Tool<
  z.infer<typeof GenerateBridgeCategoryStepInputSchema>,
  string[]
> = {
  name: "generate_bridge_category_step",
  description:
    "LLM_SMALL bridge step 1 of 2: choose the plausibly-relevant procedure categories (over-inclusive) for the confirmatory bridge workup, non-blinded (true diagnosis known).",
  inputSchema: GenerateBridgeCategoryStepInputSchema,
  invoke: (
    { presentation, diagnosis, previousProcedures, userInstructions },
    context
  ) =>
    generateBridgeCategoryStep(
      presentation,
      diagnosis,
      previousProcedures,
      userInstructions,
      context
    ),
};

// ─── generateBridgeProcedureStepFromCategories (LLM_SMALL: bridge step 2) ────

const GenerateBridgeProcedureStepFromCategoriesInputSchema = z.object({
  presentation: PresentationSchema,
  diagnosis: DiagnosisSchema,
  previousProcedures: z.array(ProcedureResultSchema).default([]),
  selectedCategories: z.array(z.string()).default([]),
  userInstructions: z.string().optional(),
});

export const generateBridgeProcedureStepFromCategoriesTool: Tool<
  z.infer<typeof GenerateBridgeProcedureStepFromCategoriesInputSchema>,
  ProcedureResult[]
> = {
  name: "generate_bridge_procedure_step_from_categories",
  description:
    "LLM_SMALL bridge step 2 of 2: generate the confirmatory bridge procedures (with results) from within the categories chosen in step 1 (plus any uncategorized procedures).",
  inputSchema: GenerateBridgeProcedureStepFromCategoriesInputSchema,
  invoke: (
    {
      presentation,
      diagnosis,
      previousProcedures,
      selectedCategories,
      userInstructions,
    },
    context
  ) =>
    generateBridgeProcedureStepFromCategories(
      presentation,
      diagnosis,
      previousProcedures,
      selectedCategories,
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

export type { ProcedureResult };

export const procedureTools = {
  generateBlindedProcedureStep: generateBlindedProcedureStepTool,
  generateBlindedCategoryStep: generateBlindedCategoryStepTool,
  generateBlindedProcedureStepFromCategories:
    generateBlindedProcedureStepFromCategoriesTool,
  generateProcedureResults: generateProcedureResultsTool,
  generateDiagnosisBridge: generateDiagnosisBridgeTool,
  generateBridgeCategoryStep: generateBridgeCategoryStepTool,
  generateBridgeProcedureStepFromCategories:
    generateBridgeProcedureStepFromCategoriesTool,
  matchDiagnosis: matchDiagnosisTool,
} as const;
