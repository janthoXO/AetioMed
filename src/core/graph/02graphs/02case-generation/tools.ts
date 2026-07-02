import z from "zod";
import { generatePatient as generatePatientGateway } from "@/core/graph/03aigateway/patient.aigateway.js";
import { generateChiefComplaint as generateChiefComplaintGateway } from "@/core/graph/03aigateway/chiefComplaint.aigateway.js";
import { generateAnamnesis as generateAnamnesisGateway } from "@/core/graph/03aigateway/anamnesis.aigateway.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import type { Patient } from "@/core/graph/models/Patient.js";
import type { ChiefComplaint } from "@/core/graph/models/ChiefComplaint.js";
import type { Anamnesis } from "@/core/graph/models/Anamnesis.js";
import type { Tool } from "@/core/graph/utils/tool.js";

// ─── Patient ─────────────────────────────────────────────────────────────────

const GeneratePatientFromOutlineInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  outline: z.string(),
  userInstructions: z.string().optional(),
});

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

const GenerateChiefComplaintFromOutlineInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  outline: z.string(),
  userInstructions: z.string().optional(),
});

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

const GenerateAnamnesisFromOutlineInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  outline: z.string(),
  userInstructions: z.string().optional(),
});

export const generateAnamnesisFromOutline: Tool<
  z.infer<typeof GenerateAnamnesisFromOutlineInputSchema>,
  Anamnesis
> = {
  name: "generate_anamnesis_from_outline",
  description: "Generate patient anamnesis from a pre-built case outline.",
  inputSchema: GenerateAnamnesisFromOutlineInputSchema,
  invoke: ({ diagnosis, outline, userInstructions }, context) =>
    generateAnamnesisGateway(
      diagnosis,
      { outline },
      userInstructions,
      undefined,
      context
    ),
};

export const generationTools = {
  generatePatientFromOutline,
  generateChiefComplaintFromOutline,
  generateAnamnesisFromOutline,
} as const;
