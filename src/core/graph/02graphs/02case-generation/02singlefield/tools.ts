import z from "zod";
import { generatePatientCoT as generatePatientCoTGateway } from "@/core/graph/03aigateway/patient.aigateway.js";
import { generateChiefComplaintCoT as generateChiefComplaintCoTGateway } from "@/core/graph/03aigateway/chiefComplaint.aigateway.js";
import { generateAnamnesisCoT as generateAnamnesisCoTGateway } from "@/core/graph/03aigateway/anamnesis.aigateway.js";
import { generateProceduresCoT as generateProceduresCoTGateway } from "@/core/graph/03aigateway/procedures.aigateway.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { SymptomSchema } from "@/core/graph/models/Symptom.js";
import { AnamnesisCategorySchema } from "@/core/graph/models/Anamnesis.js";
import type { Tool } from "@/core/graph/utils/tool.js";

const CoTInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  symptoms: z.array(SymptomSchema),
  userInstructions: z.string().optional(),
});

const AnamnesisCoTInputSchema = CoTInputSchema.extend({
  anamnesisCategories: z.array(AnamnesisCategorySchema).optional(),
});

export const generatePatientCoT: Tool<
  z.infer<typeof CoTInputSchema>,
  string
> = {
  name: "generate_patient_cot",
  description:
    "Generate chain-of-thought reasoning for patient demographics generation.",
  inputSchema: CoTInputSchema,
  invoke: ({ diagnosis, symptoms, userInstructions }, context) =>
    generatePatientCoTGateway(diagnosis, symptoms, userInstructions, context),
};

export const generateChiefComplaintCoT: Tool<
  z.infer<typeof CoTInputSchema>,
  string
> = {
  name: "generate_chief_complaint_cot",
  description:
    "Generate chain-of-thought reasoning for chief complaint generation.",
  inputSchema: CoTInputSchema,
  invoke: ({ diagnosis, symptoms, userInstructions }, context) =>
    generateChiefComplaintCoTGateway(
      diagnosis,
      symptoms,
      userInstructions,
      context
    ),
};

export const generateAnamnesisCoT: Tool<
  z.infer<typeof AnamnesisCoTInputSchema>,
  string
> = {
  name: "generate_anamnesis_cot",
  description: "Generate chain-of-thought reasoning for anamnesis generation.",
  inputSchema: AnamnesisCoTInputSchema,
  invoke: (
    { diagnosis, symptoms, anamnesisCategories, userInstructions },
    context
  ) =>
    generateAnamnesisCoTGateway(
      diagnosis,
      symptoms,
      userInstructions,
      anamnesisCategories,
      context
    ),
};

export const generateProceduresCoT: Tool<
  z.infer<typeof CoTInputSchema>,
  string
> = {
  name: "generate_procedures_cot",
  description:
    "Generate chain-of-thought reasoning for diagnostic procedures generation.",
  inputSchema: CoTInputSchema,
  invoke: ({ diagnosis, symptoms, userInstructions }, context) =>
    generateProceduresCoTGateway(
      diagnosis,
      symptoms,
      userInstructions,
      context
    ),
};

export const singleFieldCoTTools = {
  generatePatientCoT,
  generateChiefComplaintCoT,
  generateAnamnesisCoT,
  generateProceduresCoT,
} as const;
