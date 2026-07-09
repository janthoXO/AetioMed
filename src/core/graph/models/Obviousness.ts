import z from "zod";

/**
 * Result of judging whether a case blueprint reveals the diagnosis more
 * directly than the requested difficulty permits.
 */
export const ObviousnessEvaluationSchema = z.object({
  tooObvious: z
    .boolean()
    .describe(
      "true if the blueprint reveals/telegraphs the diagnosis more directly than the requested difficulty allows, false otherwise"
    ),
  reasons: z
    .array(z.string())
    .default([])
    .describe(
      "specific, concrete reasons the blueprint is too obvious (empty if not too obvious)"
    ),
  suggestion: z
    .string()
    .optional()
    .describe(
      "a single actionable directive for how to regenerate the blueprint to fit the requested difficulty (omit if not too obvious)"
    ),
});

export type ObviousnessEvaluation = z.infer<typeof ObviousnessEvaluationSchema>;
