import { z } from "zod";
import { JobCompleteEventSchema } from "@/core/jobEvents/index.js";

/** `cases.cancel.<jobId>` reply. `false` only if job finished between request and abort. */
export const CancelReplySchema = z.object({ cancelled: z.boolean() });

/** `cases.status.<jobId>` reply — never `unknown`: nobody answers then. */
export const JobStatusReplySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("active") }),
  z.object({ state: z.literal("terminal"), complete: JobCompleteEventSchema }),
]);
export type JobStatusReply = z.infer<typeof JobStatusReplySchema>;
