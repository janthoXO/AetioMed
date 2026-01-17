import z from "zod";

export const ChiefComplaintSchema = z
  .string()
  .describe("The chief complaint of the patient");

export type ChiefComplaint = z.infer<typeof ChiefComplaintSchema>;

export function ChiefComplaintDescriptionPrompt(): string {
  return "Chief Complaint: The patient's primary reason for seeking care (1-2 sentences)";
}

/**
 *
 * @returns a zod representing {chiefComplaint: string}
 */
export function ChiefComplaintJsonFormatZod(): z.ZodObject {
  return z.object({ chiefComplaint: ChiefComplaintSchema });
}

/**
 *
 * @returns a JSON format string representing {chiefComplaint: string}
 */
export function ChiefComplaintJsonFormat(): string {
  return JSON.stringify(z.toJSONSchema(ChiefComplaintJsonFormatZod()));
}
