import z from "zod";

export const ProcedureRelevanceSchema = z.enum([
  "obligatory",
  "optional",
  "contraindicated",
]);
export type ProcedureRelevance = z.infer<typeof ProcedureRelevanceSchema>;

export const ProcedureSchema = z.object({
  name: z.string().describe("Procedure name"),
  description: z.string().optional().describe("Description of the procedure"),
  relevance: ProcedureRelevanceSchema.describe(
    "Relevance of the procedure to the diagnosis"
  ),
});

export type Procedure = z.infer<typeof ProcedureSchema>;

export function ProcedureArrayJsonExampleString(): string {
  return `[
    {
      "name": "Blood Test",
      "description": "A test to analyze the patient's blood sample.",
      "relevance": ${ProcedureRelevanceSchema.options
        .map((option) => `"${option}"`)
        .join(" | ")},
    },
    {
      "name": "X-Ray",
      "description": "An imaging procedure to visualize internal structures.",
      "relevance": ${ProcedureRelevanceSchema.options
        .map((option) => `"${option}"`)
        .join(" | ")},
    },
  ]`;
}
