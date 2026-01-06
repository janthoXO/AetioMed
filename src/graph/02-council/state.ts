import {
  GenerationFlags,
} from "@/domain-models/GenerationFlags.js";
import { registry } from "@langchain/langgraph/zod";
import z from "zod";
import { CaseWithDraftIndexSchema } from "../models.js";
import { CaseSchema } from "@/domain-models/Case.js";

export const CouncilStateSchema = z.object({
  case: CaseSchema.optional(),
  // drafts from the generation step
  drafts: z.array(CaseWithDraftIndexSchema),
  councilSize: z.number().default(1),
  // accumulate votes from different council members
  votes: z.record(z.string(), z.number()).register(registry, {
    reducer: {
      fn: (a, b) => {
        const merged = { ...a };
        for (const [key, value] of Object.entries(b)) {
          merged[key] = (merged[key] ?? 0) + value;
        }
        return merged;
      },
    },
    default: () => ({}) as Record<string, number>,
  }),
  diagnosis: z.string(),
  context: z.string(),
  generationFlags: z.array(z.enum(GenerationFlags)),
});

export type CouncilState = z.infer<typeof CouncilStateSchema>;
