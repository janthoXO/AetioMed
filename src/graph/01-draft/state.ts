import { GenerationFlags } from "@/domain-models/GenerationFlags.js";
import { InconsistencySchema } from "@/domain-models/Inconsistency.js";
import { registry } from "@langchain/langgraph/zod";
import z from "zod";
import { CaseWithDraftIndexSchema } from "../models.js";
import { CaseSchema } from "@/domain-models/Case.js";

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
  diagnosis: z.string(),
  context: z.string(),
  generationFlags: z.array(z.enum(GenerationFlags)),
  inconsistencies: z.array(InconsistencySchema),
});

export type DraftState = z.infer<typeof DraftStateSchema>;
