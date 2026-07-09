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
  relevance: ProcedureRelevanceSchema.describe(
    "Relevance of the procedure to the diagnosis"
  ),
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
 * Procedure with a result — used once a procedure that was chosen during the
 * blinded solver step has had its result generated.
 */
export const ProcedureResultSchema = ProcedureSchema.extend({
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
