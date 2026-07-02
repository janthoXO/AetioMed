import z from "zod";

/**
 * Result of judging whether a case blueprint reveals the diagnosis more
 * directly than the requested difficulty permits.
 */
export const ObviousnessEvaluationSchema = z.object({
  tooObvious: z
    .boolean()
    .describe(
      "Whether the blueprint telegraphs the diagnosis more than the requested difficulty allows"
    ),
  reasons: z
    .array(z.string())
    .default([])
    .describe("Specific reasons the blueprint is too obvious, if any"),
  suggestion: z
    .string()
    .optional()
    .describe(
      "Actionable directive for how to regenerate the blueprint to be appropriately unclear"
    ),
});

export type ObviousnessEvaluation = z.infer<
  typeof ObviousnessEvaluationSchema
>;
