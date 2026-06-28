import z from "zod";
import { generateCaseOutline as generateCaseOutlineGateway } from "@/core/graph/03aigateway/case.aigateway.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { GenerationFlagSchema } from "@/core/graph/models/GenerationFlags.js";
import { SymptomSchema } from "@/core/graph/models/Symptom.js";
import type { Tool } from "@/core/graph/utils/tool.js";

const GenerateCaseOutlineInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  generationFlags: z.array(GenerationFlagSchema),
  symptoms: z.array(SymptomSchema),
  userInstructions: z.string().optional(),
});

export const generateCaseOutline: Tool<
  z.infer<typeof GenerateCaseOutlineInputSchema>,
  string
> = {
  name: "generate_case_outline",
  description:
    "Generate a structured markdown blueprint that acts as the single source of truth for downstream field generators.",
  inputSchema: GenerateCaseOutlineInputSchema,
  invoke: (
    { diagnosis, generationFlags, symptoms, userInstructions },
    context
  ) =>
    generateCaseOutlineGateway(
      diagnosis,
      generationFlags.filter((f) => f !== "procedures"),
      symptoms,
      userInstructions,
      context
    ),
};

export const fieldGenerationBlueprintTools = {
  generateCaseOutline,
} as const;
