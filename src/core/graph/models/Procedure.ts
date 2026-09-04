import z from "zod";
import { ContentPartsSchema } from "./ContentPart.js";

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
 * Procedure with a relevance and a result — both are decided non-blinded,
 * once a procedure that was chosen during the blinded solver step has had
 * its result generated. `relevance` is a judgment relative to the TRUE
 * diagnosis (which the blinded solver never sees), so it cannot be produced
 * by the blinded step — see `procedures.aigateway.ts`.
 *
 * `result` is a domain content-parts field (issue 11): one or more content
 * parts. See `ContentPart.ts` for additive-parts semantics.
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

export function buildProcedureResultSchema(procedureNames?: ProcedureName[]) {
  if (procedureNames?.length) {
    return ProcedureResultSchema.extend({
      name: z.literal(procedureNames).describe("Name of the medical procedure"),
    });
  }
  return ProcedureResultSchema;
}

/**
 * LLM-facing counterpart to `ProcedureResultSchema`: `result` stays a plain
 * `z.string()` — the LLM is never asked to emit bytes or base64 (issue 11
 * §3). Callers wrap `result` with `textPart()` to build a domain
 * `ProcedureResult` (`Procedure` type above).
 */
export const ProcedureResultTextSchema = ProcedureSchema.extend({
  relevance: ProcedureRelevanceSchema.describe(
    "Relevance of the procedure to the diagnosis"
  ),
  result: z.string().describe("Result of the procedure, if applicable"),
});
export type ProcedureResultText = z.infer<typeof ProcedureResultTextSchema>;

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
