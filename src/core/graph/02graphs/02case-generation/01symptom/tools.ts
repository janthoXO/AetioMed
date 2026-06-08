import z from "zod";
import { generateSymptomsOneShot } from "@/core/graph/03aigateway/symptoms.aigateway.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { SymptomSchema, type Symptom } from "@/core/graph/models/Symptom.js";
import type { Tool } from "@/core/graph/utils/tool.js";

const GenerateSymptomsInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  symptomsToExclude: z.array(SymptomSchema).default([]),
  userInstructions: z.string().optional(),
});

export const generateSymptoms: Tool<
  z.infer<typeof GenerateSymptomsInputSchema>,
  Symptom[]
> = {
  name: "generate_symptoms",
  description:
    "Generate a list of clinically accurate symptoms for a given diagnosis using an LLM.",
  inputSchema: GenerateSymptomsInputSchema,
  invoke: ({ diagnosis, symptomsToExclude, userInstructions }, context) =>
    generateSymptomsOneShot(
      diagnosis,
      userInstructions,
      symptomsToExclude,
      context
    ),
};

export const symptomTools = {
  generateSymptoms,
} as const;
