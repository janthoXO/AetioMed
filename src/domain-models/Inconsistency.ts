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
 *
 * @returns a zod representing {inconsistencies: Inconsistency[]}
 */
export function InconsistencyJsonFormatZod(): z.ZodObject {
  return z.object({ inconsistencies: z.array(InconsistencySchema) });
}

/**
 * @returns a JSON format string representing {inconsistencies: Inconsistency[]}
 */
export function InconsistencyJsonFormat(): string {
  return JSON.stringify(z.toJSONSchema(InconsistencyJsonFormatZod()));
}

/**
 * @returns a TOON format string representing {inconsistencies: Inconsistency[]}
 */
export function InconsistencyToonFormat(): string {
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
