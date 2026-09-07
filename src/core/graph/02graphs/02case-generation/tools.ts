import z from "zod";
import { generatePatient as generatePatientGateway } from "@/core/graph/03aigateway/patient.aigateway.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import type { Patient } from "@/core/graph/models/Patient.js";
import type { Tool } from "@/core/graph/utils/tool.js";

// ─── Patient ─────────────────────────────────────────────────────────────────
//
// `patient` is the only field in this file (issue 21 §5): `chiefComplaint`
// and `anamnesis` used to be generated here too, via
// `generateChiefComplaintFromOutline`/`generateAnamnesisFromOutline`, but
// both are now planned and rendered entirely inside their own field
// subgraphs (`02presentation/generation/chiefComplaint/`,
// `.../anamnesis/`), which call their aigateway planner/renderer functions
// directly rather than through a `Tool` wrapper here.

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
