import { CaseSchema } from "@/domain-models/Case.js";
import z from "zod";

// put draftIndex at start for better prompting
export const CaseWithDraftIndexSchema = z
  .object({
    draftIndex: z.number(),
  })
  .and(CaseSchema);

export type CaseWithDraftIndex = z.infer<typeof CaseWithDraftIndexSchema>;
