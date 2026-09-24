import { GenerationFlagSchema } from "@/core/graph/models/GenerationFlags.js";
import z from "zod";
import { CaseSchema } from "@/core/graph/models/Case.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { BasisFragmentSchema } from "@/core/graph/medicalBasis/ports.js";
import { registry } from "@langchain/langgraph/zod";
import { UserInstructionsSchema } from "@/core/graph/models/UserInstructions.js";
import { DifficultySchema } from "@/core/graph/models/Difficulty.js";

export const CaseGenerationStateSchema = z.object({
  diagnosis: DiagnosisSchema,
  userInstructions: UserInstructionsSchema.optional(),
  generationFlags: z.array(GenerationFlagSchema).min(1),
  /**
   * How unclear the diagnosis should be to a student working through the case.
   */
  difficulty: DifficultySchema.default("medium"),
  /**
   * Generated cases.
   */
  case: CaseSchema.default({}).register(registry, {
    reducer: {
      fn: (prev, next) => ({
        ...prev,
        ...next,
      }),
    },
  }),

  /** Medical-basis fragments in registry order. Empty when registry empty (no `basis_resolve` node). */
  basisFragments: BasisFragmentSchema.array().default([]),

  /** Case blueprint. Threaded to field and procedure-result generation, never to blinded solver. */
  outline: z.string().optional(),
});

export type CaseGenerationState = z.infer<typeof CaseGenerationStateSchema>;
