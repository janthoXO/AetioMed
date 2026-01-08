import { GenerationFlagsSchema } from "@/domain-models/GenerationFlags.js";
import { InconsistencySchema } from "@/domain-models/Inconsistency.js";
import z from "zod";
import { CaseSchema } from "@/domain-models/Case.js";

export const ConsistencyStateSchema = z.object({
  case: CaseSchema,
  // overwrite old inconsistencies on new update
  inconsistencies: z.array(InconsistencySchema),
  // reduce on each iteration until 0 is reached
  inconsistencyIterationsRemaining: z.number(),
  diagnosis: z.string(),
  context: z.string(),
  generationFlags: z.array(GenerationFlagsSchema),
});

export type ConsistencyState = z.infer<typeof ConsistencyStateSchema>;
