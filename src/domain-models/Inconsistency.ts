import z from "zod";
import { GenerationFlags } from "./GenerationFlags.js";
import { encode } from "@toon-format/toon";

export enum InconsistencySeverity {
  Low = "low",
  Medium = "medium",
  High = "high",
}

/**
 * Schema for consistency errors
 */
export const InconsistencySchema = z.object({
  field: z.enum(GenerationFlags).describe("Field with inconsistency"),
  description: z.string().describe("Description of the inconsistency"),
  suggestion: z
    .string()
    .describe("Suggested fix or improvement for the inconsistency"),
  severity: z.enum(InconsistencySeverity),
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
  ${Object.values(GenerationFlags)
    .filter((flag) => typeof flag === "string")
    .join(
      "|"
    )},"Description of the inconsistency","Suggested fix or improvement for the inconsistency",${Object.values(
    InconsistencySeverity
  )
    .filter((flag) => typeof flag === "string")
    .join("|")}`;
}

export function InconsistencyEmptyToonFormat(): string {
  return `inconsistencies${encode([])}`;
}
