import z from "zod";
import { generateCaseOutline as generateCaseOutlineGateway } from "@/core/graph/03aigateway/case.aigateway.js";
import { evaluateOutline as evaluateOutlineGateway } from "@/core/graph/03aigateway/outlineEvaluation.aigateway.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { GenerationFlagSchema } from "@/core/graph/models/GenerationFlags.js";
import { BasisFragmentSchema } from "@/core/graph/medicalBasis/ports.js";
import { DifficultySchema } from "@/core/graph/models/Difficulty.js";
import type { OutlineEvaluation } from "@/core/graph/models/OutlineEvaluation.js";
import type { Tool } from "@/core/graph/utils/tool.js";

const GenerateCaseOutlineInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  generationFlags: z.array(GenerationFlagSchema),
  basisFragments: z.array(BasisFragmentSchema),
  difficulty: DifficultySchema,
  userInstructions: z.string().optional(),
  feedback: z.array(z.string()).optional(),
  previousOutline: z.string().optional(),
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
      basisFragments,
      difficulty,
      userInstructions,
      feedback,
      previousOutline,
    },
    runtime,
    context
  ) =>
    generateCaseOutlineGateway(
      runtime,
      diagnosis,
      generationFlags.filter((f) => f !== "procedures"),
      basisFragments,
      difficulty,
      userInstructions,
      feedback,
      previousOutline,
      context
    ),
};

// ─── combined outline evaluation (obviousness + consistency) ──────────────────

const EvaluateOutlineInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  outline: z.string(),
  difficulty: DifficultySchema,
  userInstructions: z.string().optional(),
});

export const evaluateOutline: Tool<
  z.infer<typeof EvaluateOutlineInputSchema>,
  OutlineEvaluation
> = {
  name: "evaluate_outline",
  description:
    "Judge in one call whether a case blueprint is too obvious for the requested difficulty and whether it is clinically consistent.",
  inputSchema: EvaluateOutlineInputSchema,
  invoke: (
    { diagnosis, outline, difficulty, userInstructions },
    runtime,
    context
  ) =>
    evaluateOutlineGateway(
      runtime,
      diagnosis,
      outline,
      difficulty,
      userInstructions,
      context
    ),
};

export const fieldGenerationBlueprintTools = {
  generateCaseOutline,
  evaluateOutline,
} as const;

export type { OutlineEvaluation };
