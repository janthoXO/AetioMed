import z from "zod";
import { encode } from "@toon-format/toon";
import {
  AllGenerationFlags,
  GenerationFlagsSchema,
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
    field: "anamnesis",
    description: "The anamnesis contradicts the chief complaint.",
    suggestion:
      "Review the anamnesis and ensure it aligns with the chief complaint.",
    severity: "high",
  };
}

/**
 * @returns a TOON format string representing {inconsistencies: Inconsistency[]}
 */
export function InconsistencyArrayToonFormat(): string {
  return `inconsistencies[N]{field,description,suggestion,severity}:
  ${AllGenerationFlags.filter((flag) => typeof flag === "string").join(
    "|"
  )},"Description of the inconsistency","Suggested fix or improvement for the inconsistency",${AllInconsistencySeverity.filter(
    (flag) => typeof flag === "string"
  ).join("|")}`;
}

export function InconsistencyEmptyToonFormat(): string {
  return `inconsistencies${encode([])}`;
}
