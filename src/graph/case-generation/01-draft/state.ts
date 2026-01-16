import { GenerationFlagsSchema } from "@/domain-models/GenerationFlags.js";
import { InconsistencySchema } from "@/domain-models/Inconsistency.js";
import { registry } from "@langchain/langgraph/zod";
import z from "zod";
import { CaseWithDraftIndexSchema } from "../models.js";
import { CaseSchema } from "@/domain-models/Case.js";
import { ICDCodeSchema } from "@/domain-models/ICD.js";

export const DraftStateSchema = z.object({
  case: CaseSchema.optional(),
  // append all drafts from different branches
  drafts: z.array(CaseWithDraftIndexSchema).register(registry, {
    reducer: {
      fn: (a, b) => [...a, ...b],
    },
    default: () => [],
  }),
  draftCount: z.number().default(1),
  icdCode: ICDCodeSchema.optional(),
  diagnosis: z.string(),
  context: z.string().optional(),
  generationFlags: z.array(GenerationFlagsSchema),
  inconsistencies: z.array(InconsistencySchema),
});

export type DraftState = z.infer<typeof DraftStateSchema>;
