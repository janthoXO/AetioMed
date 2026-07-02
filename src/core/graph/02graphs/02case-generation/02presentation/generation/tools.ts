import z from "zod";
import { generateCaseOutline as generateCaseOutlineGateway } from "@/core/graph/03aigateway/case.aigateway.js";
import { evaluateOutlineObviousness as evaluateOutlineObviousnessGateway } from "@/core/graph/03aigateway/obviousness.aigateway.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { GenerationFlagSchema } from "@/core/graph/models/GenerationFlags.js";
import { SymptomSchema } from "@/core/graph/models/Symptom.js";
import { DifficultySchema } from "@/core/graph/models/Difficulty.js";
import type { ObviousnessEvaluation } from "@/core/graph/models/Obviousness.js";
import type { Tool } from "@/core/graph/utils/tool.js";

const GenerateCaseOutlineInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  generationFlags: z.array(GenerationFlagSchema),
  symptoms: z.array(SymptomSchema),
  difficulty: DifficultySchema.default("medium"),
  userInstructions: z.string().optional(),
  feedback: z.array(z.string()).optional(),
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
    {
      diagnosis,
      generationFlags,
      symptoms,
      difficulty,
      userInstructions,
      feedback,
    },
    context
  ) =>
    generateCaseOutlineGateway(
      diagnosis,
      generationFlags.filter((f) => f !== "procedures"),
      symptoms,
      difficulty,
      userInstructions,
      feedback,
      context
    ),
};

// ─── obviousness check ─────────────────────────────────────────────────────────

const EvaluateOutlineObviousnessInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  outline: z.string(),
  difficulty: DifficultySchema.default("medium"),
  userInstructions: z.string().optional(),
});

export const evaluateOutlineObviousness: Tool<
  z.infer<typeof EvaluateOutlineObviousnessInputSchema>,
  ObviousnessEvaluation
> = {
  name: "evaluate_outline_obviousness",
  description:
    "Judge whether a case blueprint reveals the diagnosis more directly than the requested difficulty allows.",
  inputSchema: EvaluateOutlineObviousnessInputSchema,
  invoke: ({ diagnosis, outline, difficulty, userInstructions }, context) =>
    evaluateOutlineObviousnessGateway(
      diagnosis,
      outline,
      difficulty,
      userInstructions,
      context
    ),
};

export const fieldGenerationBlueprintTools = {
  generateCaseOutline,
  evaluateOutlineObviousness,
} as const;

export type { ObviousnessEvaluation };
