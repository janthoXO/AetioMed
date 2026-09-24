import z from "zod";
import { ContentPartsSchema } from "./ContentPart.js";
import { PlannedPartSchema } from "../modality/ports.js";

export const ProcedureNameSchema = z
  .string()
  .describe("Name of the medical procedure");

export type ProcedureName = z.infer<typeof ProcedureNameSchema>;

export const ProcedureRelevanceSchema = z.enum([
  "obligatory",
  "optional",
  "contraindicated",
]);
export type ProcedureRelevance = z.infer<typeof ProcedureRelevanceSchema>;

export const ProcedureSchema = z.object({
  name: ProcedureNameSchema,
});

export type Procedure = z.infer<typeof ProcedureSchema>;

export function buildProcedureSchema(procedureNames?: ProcedureName[]) {
  if (procedureNames?.length) {
    return ProcedureSchema.extend({
      name: z.literal(procedureNames).describe("Name of the medical procedure"),
    });
  }

  return ProcedureSchema;
}

/**
 * Procedure with relevance and result, both decided non-blinded.
 * `relevance` is judged against the TRUE diagnosis, so the blinded step
 * cannot produce it (see `procedures.aigateway.ts`). `result` is content
 * parts; see `ContentPart.ts`.
 */
export const ProcedureResultSchema = ProcedureSchema.extend({
  relevance: ProcedureRelevanceSchema.describe(
    "Relevance of the procedure to the diagnosis"
  ),
  result: ContentPartsSchema.describe(
    "Result of the procedure, as one or more content parts"
  ),
});
export type ProcedureResult = z.infer<typeof ProcedureResultSchema>;

/** LLM-facing `ProcedureResultSchema`: `result` plain `z.string()`, never bytes. Callers wrap into a `ContentPart`. */
export const ProcedureResultTextSchema = ProcedureSchema.extend({
  relevance: ProcedureRelevanceSchema.describe(
    "Relevance of the procedure to the diagnosis"
  ),
  result: z.string().describe("Result of the procedure, if applicable"),
});

export function buildProcedureResultTextSchema(
  procedureNames?: ProcedureName[]
) {
  if (procedureNames?.length) {
    return ProcedureResultTextSchema.extend({
      name: z.literal(procedureNames).describe("Name of the medical procedure"),
    });
  }
  return ProcedureResultTextSchema;
}

/**
 * Procedure decided by the solver loop but not yet rendered: non-blinded
 * `relevance`, plus an ORDERED list of render requests instead of `result`.
 * `render_results` (`03procedure/index.ts`) is the only node turning these
 * into `ProcedureResult[]`, once, after solving.
 *
 * `parts` are `PlannedPart`s, no bytes yet. Here `alt` is NOT a short label:
 * it is the self-contained clinical finding, since the blinded solver reasons
 * over `alt` alone. See `planProcedureResults` in `procedures.aigateway.ts`.
 */
export const PlannedProcedureSchema = z.object({
  name: ProcedureNameSchema,
  relevance: ProcedureRelevanceSchema.describe(
    "Relevance of the procedure to the TRUE diagnosis"
  ),
  parts: z
    .array(PlannedPartSchema)
    .min(1)
    .describe("Ordered render requests that will compose this result"),
});
export type PlannedProcedure = z.infer<typeof PlannedProcedureSchema>;
