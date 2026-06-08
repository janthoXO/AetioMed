import z from "zod";
import {
  generateCaseCoT as generateCaseCoTGateway,
  generateCaseOutline as generateCaseOutlineGateway,
} from "@/core/graph/03aigateway/case.aigateway.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { GenerationFlagSchema } from "@/core/graph/models/GenerationFlags.js";
import { SymptomSchema } from "@/core/graph/models/Symptom.js";
import type { Tool } from "@/core/graph/utils/tool.js";

const GenerateCaseCoTInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  generationFlags: z.array(GenerationFlagSchema),
  userInstructions: z.string().optional(),
});

const GenerateCaseOutlineInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  generationFlags: z.array(GenerationFlagSchema),
  symptoms: z.array(SymptomSchema),
  cot: z.string(),
  userInstructions: z.string().optional(),
});

export const generateCaseCoT: Tool<
  z.infer<typeof GenerateCaseCoTInputSchema>,
  string
> = {
  name: "generate_case_cot",
  description:
    "Generate a step-by-step chain-of-thought reasoning for constructing a cohesive multi-field medical case.",
  inputSchema: GenerateCaseCoTInputSchema,
  invoke: ({ diagnosis, generationFlags, userInstructions }, context) =>
    generateCaseCoTGateway(
      diagnosis,
      generationFlags.filter((f) => f !== "procedures"),
      userInstructions,
      context
    ),
};

export const generateCaseOutline: Tool<
  z.infer<typeof GenerateCaseOutlineInputSchema>,
  string
> = {
  name: "generate_case_outline",
  description:
    "Generate a structured markdown blueprint that acts as the single source of truth for downstream field generators.",
  inputSchema: GenerateCaseOutlineInputSchema,
  invoke: (
    { diagnosis, generationFlags, symptoms, cot, userInstructions },
    context
  ) =>
    generateCaseOutlineGateway(
      diagnosis,
      generationFlags.filter((f) => f !== "procedures"),
      symptoms,
      cot,
      userInstructions,
      context
    ),
};

export const fieldGenerationBlueprintTools = {
  generateCaseCoT,
  generateCaseOutline,
} as const;
