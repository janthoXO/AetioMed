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

  const procedureEntries = z
    .object({
      procedures: ProcedureSchema.array(),
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

export const PredefinedProcedures: Procedure[] | undefined =
  preloadPredefinedProcedures();

export const ProcedureRelevanceSchema = z.enum([
  "obligatory",
  "optional",
  "contraindicated",
]);
export type ProcedureRelevance = z.infer<typeof ProcedureRelevanceSchema>;

export const ProcedureGenerationSchema = ProcedureSchema.extend({
  relevance: ProcedureRelevanceSchema.describe(
    "Relevance of the procedure to the diagnosis"
  ),
  result: z.string().describe("Result of the procedure, if applicable"),
});

export type ProcedureGeneration = z.infer<typeof ProcedureGenerationSchema>;

export function ProcedureGenerationArrayJsonExampleString(): string {
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
