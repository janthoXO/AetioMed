import z from "zod";

export const ChiefComplaintSchema = z
  .string()
  .describe("The chief complaint of the patient");

export type ChiefComplaint = z.infer<typeof ChiefComplaintSchema>;

export function ChiefComplaintDescriptionPrompt(): string {
  return "Chief Complaint: The patient's primary reason for seeking care (1-2 sentences)";
}

export function ChiefComplaintToonFormat(): string {
  return 'chiefComplaint: "Patient presents with..."';
}
