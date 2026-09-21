import { z } from "zod";
import { OutlineSegmentsSchema } from "@/core/graph/outline/segments.js";

/**
 * A reviewer's decision on a paused plan-mode job (#159), shared by REST's
 * `POST /api/cases/:jobId/review` and NATS's `cases.decision.<jobId>`.
 * `revision` pins the decision to the review it answers — a stale one is
 * rejected, never applied to a newer outline.
 */
export const ReviewDecisionRequestSchema = z.object({
  revision: z.number().int().min(1),
  decision: z.discriminatedUnion("action", [
    z.object({ action: z.literal("approve") }),
    z.object({ action: z.literal("edit"), outline: OutlineSegmentsSchema }),
    z.object({
      action: z.literal("revise"),
      feedback: z.array(z.string().trim().min(1).max(2_000)).min(1).max(20),
    }),
  ]),
});

export type ReviewDecisionRequest = z.infer<typeof ReviewDecisionRequestSchema>;
export type ReviewDecision = ReviewDecisionRequest["decision"];
