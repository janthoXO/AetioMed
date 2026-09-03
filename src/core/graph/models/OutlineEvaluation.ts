import z from "zod";

/**
 * Result of judging a case blueprint on both quality dimensions at once:
 * obviousness (does it telegraph the diagnosis beyond what the requested
 * difficulty permits?) and clinical consistency (coherence, realism,
 * diagnosis secrecy).
 */
export const OutlineEvaluationSchema = z.object({
  accepted: z
    .boolean()
    .describe(
      "true if the blueprint fits the requested difficulty AND is clinically consistent, false otherwise"
    ),
  reasons: z
    .array(z.string())
    .default([])
    .describe(
      "specific, concrete problems found — obviousness or consistency (empty if accepted)"
    ),
  suggestion: z
    .string()
    .optional()
    .describe(
      "a single actionable directive for how to revise the blueprint (omit if accepted)"
    ),
});

export type OutlineEvaluation = z.infer<typeof OutlineEvaluationSchema>;
