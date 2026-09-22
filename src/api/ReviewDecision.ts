import { z } from "zod";
import { OutlineSegmentsSchema } from "@/core/graph/outline/segments.js";
import { LLMConfigSchema } from "@/core/graph/models/LLMConfig.js";
import type { Config } from "@/core/graph/config.js";

const BaseReviewDecisionRequestSchema = z.object({
  revision: z.number().int().min(1),
  decision: z.discriminatedUnion("action", [
    z.object({ action: z.literal("approve") }),
    z.object({ action: z.literal("edit"), outline: OutlineSegmentsSchema }),
    z.object({
      action: z.literal("revise"),
      feedback: z.array(z.string().trim().min(1).max(2_000)).min(1).max(20),
    }),
  ]),
  llmConfig: LLMConfigSchema.optional().describe(
    "Optional per-request model selection for the rest of this job. Replaces " +
      "the config the job was started (or last decided) with, API key " +
      "included; omitted, the stored one is used."
  ),
});

/**
 * A reviewer's decision on a paused plan-mode job (#159), shared by REST's
 * `POST /api/cases/:jobId/review` and NATS's `cases.decision.<jobId>`.
 * `revision` pins the decision to the review it answers — a stale one is
 * rejected, never applied to a newer outline. `llmConfig` follows the create
 * request's rule: not allowed when a global LLM is configured.
 */
export function makeReviewDecisionRequestSchema(config: Config) {
  return BaseReviewDecisionRequestSchema.refine(
    (data) => !(data.llmConfig && config.llm),
    {
      message: "LLM config is not allowed when a global LLM is configured",
      path: ["llmConfig"],
    }
  );
}

export type ReviewDecisionRequest = z.infer<
  typeof BaseReviewDecisionRequestSchema
>;
export type ReviewDecision = ReviewDecisionRequest["decision"];
