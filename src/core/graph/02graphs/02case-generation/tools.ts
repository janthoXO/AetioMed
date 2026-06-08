import z from "zod";
import { generatePatient as generatePatientGateway } from "@/core/graph/03aigateway/patient.aigateway.js";
import { generateChiefComplaint as generateChiefComplaintGateway } from "@/core/graph/03aigateway/chiefComplaint.aigateway.js";
import { generateAnamnesis as generateAnamnesisGateway } from "@/core/graph/03aigateway/anamnesis.aigateway.js";
import { generateProcedures as generateProceduresGateway } from "@/core/graph/03aigateway/procedures.aigateway.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { SymptomSchema } from "@/core/graph/models/Symptom.js";
import { AnamnesisCategorySchema } from "@/core/graph/models/Anamnesis.js";
import {
  PredefinedProcedureNames,
  ProcedureNameSchema,
  type Procedure,
} from "@/core/graph/models/Procedure.js";
import type { Patient } from "@/core/graph/models/Patient.js";
import type { ChiefComplaint } from "@/core/graph/models/ChiefComplaint.js";
import type { Anamnesis } from "@/core/graph/models/Anamnesis.js";
import { CaseSchema } from "@/core/graph/models/Case.js";
import type { Tool } from "@/core/graph/utils/tool.js";

// ─── Patient ─────────────────────────────────────────────────────────────────

const GeneratePatientFromCoTInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  cot: z.string(),
  symptoms: z.array(SymptomSchema),
  userInstructions: z.string().optional(),
});

const GeneratePatientFromOutlineInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  outline: z.string(),
  userInstructions: z.string().optional(),
});

export const generatePatientFromCoT: Tool<
  z.infer<typeof GeneratePatientFromCoTInputSchema>,
  Patient
> = {
  name: "generate_patient_from_cot",
  description:
    "Generate patient demographics using a chain-of-thought reasoning and symptom list.",
  inputSchema: GeneratePatientFromCoTInputSchema,
  invoke: ({ diagnosis, cot, symptoms, userInstructions }, context) =>
    generatePatientGateway(
      diagnosis,
      { cot, symptoms },
      userInstructions,
      context
    ),
};

export const generatePatientFromOutline: Tool<
  z.infer<typeof GeneratePatientFromOutlineInputSchema>,
  Patient
> = {
  name: "generate_patient_from_outline",
  description: "Generate patient demographics from a pre-built case outline.",
  inputSchema: GeneratePatientFromOutlineInputSchema,
  invoke: ({ diagnosis, outline, userInstructions }, context) =>
    generatePatientGateway(diagnosis, { outline }, userInstructions, context),
};

// ─── Chief Complaint ──────────────────────────────────────────────────────────

const GenerateChiefComplaintFromCoTInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  cot: z.string(),
  symptoms: z.array(SymptomSchema),
  userInstructions: z.string().optional(),
});

const GenerateChiefComplaintFromOutlineInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  outline: z.string(),
  userInstructions: z.string().optional(),
});

export const generateChiefComplaintFromCoT: Tool<
  z.infer<typeof GenerateChiefComplaintFromCoTInputSchema>,
  ChiefComplaint
> = {
  name: "generate_chief_complaint_from_cot",
  description:
    "Generate the chief complaint using a chain-of-thought reasoning and symptom list.",
  inputSchema: GenerateChiefComplaintFromCoTInputSchema,
  invoke: ({ diagnosis, cot, symptoms, userInstructions }, context) =>
    generateChiefComplaintGateway(
      diagnosis,
      { cot, symptoms },
      userInstructions,
      context
    ),
};

export const generateChiefComplaintFromOutline: Tool<
  z.infer<typeof GenerateChiefComplaintFromOutlineInputSchema>,
  ChiefComplaint
> = {
  name: "generate_chief_complaint_from_outline",
  description: "Generate the chief complaint from a pre-built case outline.",
  inputSchema: GenerateChiefComplaintFromOutlineInputSchema,
  invoke: ({ diagnosis, outline, userInstructions }, context) =>
    generateChiefComplaintGateway(
      diagnosis,
      { outline },
      userInstructions,
      context
    ),
};

// ─── Anamnesis ────────────────────────────────────────────────────────────────

const GenerateAnamnesisFromCoTInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  cot: z.string(),
  symptoms: z.array(SymptomSchema),
  anamnesisCategories: z.array(AnamnesisCategorySchema).optional(),
  userInstructions: z.string().optional(),
});

const GenerateAnamnesisFromOutlineInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  outline: z.string(),
  anamnesisCategories: z.array(AnamnesisCategorySchema).optional(),
  userInstructions: z.string().optional(),
});

export const generateAnamnesisFromCoT: Tool<
  z.infer<typeof GenerateAnamnesisFromCoTInputSchema>,
  Anamnesis
> = {
  name: "generate_anamnesis_from_cot",
  description:
    "Generate patient anamnesis using a chain-of-thought reasoning and symptom list.",
  inputSchema: GenerateAnamnesisFromCoTInputSchema,
  invoke: (
    { diagnosis, cot, symptoms, anamnesisCategories, userInstructions },
    context
  ) =>
    generateAnamnesisGateway(
      diagnosis,
      { cot, symptoms },
      userInstructions,
      anamnesisCategories,
      context
    ),
};

export const generateAnamnesisFromOutline: Tool<
  z.infer<typeof GenerateAnamnesisFromOutlineInputSchema>,
  Anamnesis
> = {
  name: "generate_anamnesis_from_outline",
  description: "Generate patient anamnesis from a pre-built case outline.",
  inputSchema: GenerateAnamnesisFromOutlineInputSchema,
  invoke: (
    { diagnosis, outline, anamnesisCategories, userInstructions },
    context
  ) =>
    generateAnamnesisGateway(
      diagnosis,
      { outline },
      userInstructions,
      anamnesisCategories,
      context
    ),
};

// ─── Procedures ───────────────────────────────────────────────────────────────

const GenerateProceduresFromCoTInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  cot: z.string(),
  symptoms: z.array(SymptomSchema),
  procedureNameList: z.array(ProcedureNameSchema).optional(),
  userInstructions: z.string().optional(),
});

const GenerateProceduresFromCaseInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  case: CaseSchema,
  procedureNameList: z.array(ProcedureNameSchema).optional(),
  userInstructions: z.string().optional(),
});

export const generateProceduresFromCoT: Tool<
  z.infer<typeof GenerateProceduresFromCoTInputSchema>,
  Procedure[]
> = {
  name: "generate_procedures_forward",
  description:
    "Generate diagnostic procedures from chain-of-thought reasoning (single-field path).",
  inputSchema: GenerateProceduresFromCoTInputSchema,
  invoke: (
    { diagnosis, cot, symptoms, procedureNameList, userInstructions },
    context
  ) =>
    generateProceduresGateway(
      diagnosis,
      { cot, symptoms },
      userInstructions,
      procedureNameList ?? PredefinedProcedureNames,
      context
    ),
};

export const generateProceduresFromCase: Tool<
  z.infer<typeof GenerateProceduresFromCaseInputSchema>,
  Procedure[]
> = {
  name: "generate_procedures_backward",
  description:
    "Generate diagnostic procedures from the full case context (multi-field path).",
  inputSchema: GenerateProceduresFromCaseInputSchema,
  invoke: (
    { diagnosis, case: c, procedureNameList, userInstructions },
    context
  ) =>
    generateProceduresGateway(
      diagnosis,
      { case: c },
      userInstructions,
      procedureNameList ?? PredefinedProcedureNames,
      context
    ),
};

export const generationTools = {
  generatePatientFromCoT,
  generatePatientFromOutline,
  generateChiefComplaintFromCoT,
  generateChiefComplaintFromOutline,
  generateAnamnesisFromCoT,
  generateAnamnesisFromOutline,
  generateProceduresFromCoT,
  generateProceduresFromCase,
} as const;
