import z from "zod";

export const ChiefComplaintSchema = z
  .string()
  .describe("The chief complaint of the patient");

export type ChiefComplaint = z.infer<typeof ChiefComplaintSchema>;

export function ChiefComplaintDescriptionPrompt(): string {
  return "Chief Complaint: The patient's primary reason for seeking care (1-2 sentences)";
}

export const ChiefComplaintJsonSchema = z.object({
  chiefComplaint: ChiefComplaintSchema,
});

export type ChiefComplaintJson = z.infer<typeof ChiefComplaintJsonSchema>;

/**
 *
 * @returns a JSON format string representing {chiefComplaint: string}
 */
export function ChiefComplaintJsonFormat(): string {
  return JSON.stringify(z.toJSONSchema(ChiefComplaintJsonSchema));
}

export function ChiefComplaintExample(): ChiefComplaint {
  return "The patient's primary reason for seeking care in the words of the doctor";
}

export function ChiefComplaintJsonExample(): ChiefComplaintJson {
  return {
    chiefComplaint: ChiefComplaintExample(),
  };
}
