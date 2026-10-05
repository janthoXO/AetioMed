import { GenerationFlagSchema } from "@/core/graph/shared/domain/GenerationFlags.js";
import z from "zod";
import { CaseSchema } from "@/core/graph/shared/domain/Case.js";
import { DiagnosisSchema } from "@/core/graph/shared/domain/Diagnosis.js";
import { BasisFragmentSchema } from "@/core/graph/02-plan/01-basis/ports.js";
import { registry } from "@langchain/langgraph/zod";
import { UserInstructionsSchema } from "@/core/graph/shared/domain/UserInstructions.js";
import { DifficultySchema } from "@/core/graph/shared/domain/Difficulty.js";

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

  /**
   * Outline's presentation sections (`presentationSections`): the blinded
   * solver's view of a field not generated (#205). Never `## General` or `## Procedures`.
   */
  outlineSections: z
    .object({
      patient: z.string(),
      chiefComplaint: z.string(),
      anamnesis: z.string(),
    })
    .optional(),
});

export type CaseGenerationState = z.infer<typeof CaseGenerationStateSchema>;
