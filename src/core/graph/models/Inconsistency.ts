import z from "zod";
import { GenerationFlagSchema } from "./GenerationFlags.js";

const InconsistencySeveritySchema = z.enum(["low", "medium", "high"]);

export type InconsistencySeverity = z.infer<typeof InconsistencySeveritySchema>;

/**
 * Schema for consistency errors
 */
export const InconsistencySchema = z.object({
  field: GenerationFlagSchema.describe("Field with inconsistency"),
  description: z.string().describe("Description of the inconsistency"),
  suggestion: z
    .string()
    .describe("Suggested fix or improvement for the inconsistency"),
  severity: InconsistencySeveritySchema.describe(
    "Severity of the inconsistency"
  ),
});

export type Inconsistency = z.infer<typeof InconsistencySchema>;
