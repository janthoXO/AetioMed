import z from "zod";

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
 */
export const ProcedureResultSchema = ProcedureSchema.extend({
  relevance: ProcedureRelevanceSchema.describe(
    "Relevance of the procedure to the diagnosis"
  ),
  result: z.string().describe("Result of the procedure, if applicable"),
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
