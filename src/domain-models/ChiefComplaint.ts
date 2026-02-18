import z from "zod";

export const ChiefComplaintSchema = z
  .string()
  .describe("The chief complaint of the patient");

export type ChiefComplaint = z.infer<typeof ChiefComplaintSchema>;

export function ChiefComplaintExample(): ChiefComplaint {
  return "The patient's primary reason for seeking care in the words of the doctor";
}

export const ChiefComplaintJsonSchema = z.object({
  chiefComplaint: ChiefComplaintSchema,
});

export type ChiefComplaintJson = z.infer<typeof ChiefComplaintJsonSchema>;

export function ChiefComplaintJsonExample(): ChiefComplaintJson {
  return {
    chiefComplaint: ChiefComplaintExample(),
  };
}

export function ChiefComplaintJsonExampleString(): string {
  return JSON.stringify(ChiefComplaintJsonExample(), null, 2);
}
