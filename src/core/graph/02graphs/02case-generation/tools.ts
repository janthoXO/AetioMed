import z from "zod";
import { generatePatient as generatePatientGateway } from "@/core/graph/03aigateway/patient.aigateway.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import type { Patient } from "@/core/graph/models/Patient.js";
import type { Tool } from "@/core/graph/utils/tool.js";

// ─── Patient ─────────────────────────────────────────────────────────────────
//
// `patient` only field here; chiefComplaint/anamnesis planned and rendered in their own subgraphs.

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
  invoke: ({ diagnosis, outline, userInstructions }, runtime, context) =>
    generatePatientGateway(
      runtime,
      diagnosis,
      outline,
      userInstructions,
      context
    ),
};

export const generationTools = {
  generatePatientFromOutline,
} as const;
