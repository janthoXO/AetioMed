import z from "zod";

export const SymptomSchema = z.object({
  name: z.string().describe("Symptom name"),
  description: z.string().optional().describe("Description of the symptom"),
});

export type Symptom = z.infer<typeof SymptomSchema>;

export function SymptomArrayJsonExample(): Symptom[] {
  return [
    {
      name: "Headache",
      description: "A pain or discomfort in the head or neck region",
    },
    {
      name: "Fatigue",
      description: "A feeling of tiredness or exhaustion",
    },
  ];
}
