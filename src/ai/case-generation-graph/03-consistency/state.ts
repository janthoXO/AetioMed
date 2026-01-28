import { GenerationFlagSchema } from "@/domain-models/GenerationFlags.js";
import { InconsistencySchema } from "@/domain-models/Inconsistency.js";
import z from "zod";
import { CaseSchema } from "@/domain-models/Case.js";
import { DiagnosisSchema } from "@/domain-models/Diagnosis.js";

export const ConsistencyStateSchema = z.object({
  case: CaseSchema.optional(),
  // overwrite old inconsistencies on new update
  inconsistencies: z.array(InconsistencySchema),
  // reduce on each iteration until 0 is reached
  loopIterationsRemaining: z.number(),
  diagnosis: DiagnosisSchema,
  context: z.string().optional(),
  generationFlags: z.array(GenerationFlagSchema),
});

export type ConsistencyState = z.infer<typeof ConsistencyStateSchema>;
