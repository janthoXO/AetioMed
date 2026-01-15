import z from "zod";

export const SymptomSchema = z.object({
  cui: z.string().describe("Concept Unique Identifier"),
  name: z.string().describe("Symptom name"),
  description: z.string().optional().describe("Description of the symptom"),
});

export type Symptom = z.infer<typeof SymptomSchema>;
