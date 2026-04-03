import z from "zod";
import fs from "node:fs";
import YAML from "yaml";
import path from "node:path";

export const ProcedureNameSchema = z
  .string()
  .describe("Name of the medical procedure");

export type ProcedureName = z.infer<typeof ProcedureNameSchema>;

function preloadPredefinedProcedures(): ProcedureName[] | undefined {
  const filepath = path.resolve(process.cwd(), "data/procedures.yml");

  if (!fs.existsSync(filepath)) {
    console.warn("[Procedure Repo] No procedures.yml found, skipping preload.");
    return undefined;
  }

  const procedureEntries = z
    .object({
      procedures: ProcedureNameSchema.array(),
    })
    .safeParse(YAML.parse(fs.readFileSync(filepath, "utf-8")));

  if (!procedureEntries.success) {
    console.error("[Procedure] Failed to load predefined procedures from YAML");
    return undefined;
  }

  console.info(
    `[Procedure] Loaded ${procedureEntries.data.procedures.length} predefined procedures from YAML`
  );

  return procedureEntries.data.procedures;
}

export const PredefinedProcedureNames: ProcedureName[] | undefined =
  preloadPredefinedProcedures();

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
  result: z.string().describe("Result of the procedure, if applicable"),
});

export type Procedure = z.infer<typeof ProcedureSchema>;

export function ProcedureArrayJsonExampleString(): string {
  return `[
    {
      "name": "Blood Test",
      "relevance": ${ProcedureRelevanceSchema.options
        .map((option) => `"${option}"`)
        .join(" | ")},
      "result": "Normal"
    },
    {
      "name": "X-Ray",
      "relevance": ${ProcedureRelevanceSchema.options
        .map((option) => `"${option}"`)
        .join(" | ")},
      "result": "Abnormal shadow in the left lung"
    },
  ]`;
}
