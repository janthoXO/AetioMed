import z from "zod";
import {
  AllGenerationFlags,
  GenerationFlagsSchema,
  type GenerationFlags,
} from "./GenerationFlags.js";

const InconsistencySeveritySchema = z.enum(["low", "medium", "high"]);

export type InconsistencySeverity = z.infer<typeof InconsistencySeveritySchema>;

const AllInconsistencySeverity = InconsistencySeveritySchema.options;

/**
 * Schema for consistency errors
 */
export const InconsistencySchema = z.object({
  field: GenerationFlagsSchema.describe("Field with inconsistency"),
  description: z.string().describe("Description of the inconsistency"),
  suggestion: z
    .string()
    .describe("Suggested fix or improvement for the inconsistency"),
  severity: InconsistencySeveritySchema.describe(
    "Severity of the inconsistency"
  ),
});

export type Inconsistency = z.infer<typeof InconsistencySchema>;

/**
 * a zod representing {inconsistencies: Inconsistency[]}
 */
export const InconsistencyArrayJsonFormatZod = z.object({
  inconsistencies: z.array(InconsistencySchema),
});

export function InconsistencyJsonExample(): Inconsistency {
  return {
    field: AllGenerationFlags.join(" | ") as GenerationFlags,
    description: "e.g. the anamnesis contradicts the chief complaint.",
    suggestion:
      "Review the anamnesis and ensure it aligns with the chief complaint.",
    severity: AllInconsistencySeverity.join(" | ") as InconsistencySeverity,
  };
}
