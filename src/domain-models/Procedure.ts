import z from "zod";
import fs from "node:fs";
import YAML from "yaml";
import path from "node:path";

export const ProcedureSchema = z.object({
  name: z.string().describe("Procedure name"),
});

export type Procedure = z.infer<typeof ProcedureSchema>;

function preloadPredefinedProcedures(): Procedure[] | undefined {
  const filepath = path.resolve(import.meta.dirname, "../data/procedures.yml");

  const procedureObject = YAML.parse(fs.readFileSync(filepath, "utf-8")) as
    | {
        procedures: Procedure[];
      }
    | undefined;

  console.info(
    "[Procedure] Loaded predefined procedures from YAML:",
    procedureObject?.procedures
  );

  return procedureObject?.procedures;
}

export const PredefinedProcedures: Procedure[] | undefined =
  preloadPredefinedProcedures();

export const ProcedureRelevanceSchema = z.enum([
  "obligatory",
  "optional",
  "contraindicated",
]);
export type ProcedureRelevance = z.infer<typeof ProcedureRelevanceSchema>;

export const ProcedureWithRelevanceSchema = ProcedureSchema.extend({
  relevance: ProcedureRelevanceSchema.describe(
    "Relevance of the procedure to the diagnosis"
  ),
});

export type ProcedureWithRelevance = z.infer<
  typeof ProcedureWithRelevanceSchema
>;

export function ProcedureWithRelevanceArrayJsonExampleString(): string {
  return `[
    {
      "name": "Blood Test",
      "relevance": ${ProcedureRelevanceSchema.options
        .map((option) => `"${option}"`)
        .join(" | ")},
    },
    {
      "name": "X-Ray",
      "relevance": ${ProcedureRelevanceSchema.options
        .map((option) => `"${option}"`)
        .join(" | ")},
    },
  ]`;
}
