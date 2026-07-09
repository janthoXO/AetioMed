import z from "zod";

export const ChiefComplaintSchema = z
  .string()
  .describe("The chief complaint of the patient");

export type ChiefComplaint = z.infer<typeof ChiefComplaintSchema>;

export const ChiefComplaintJsonSchema = z.object({
  chiefComplaint: ChiefComplaintSchema,
});

export type ChiefComplaintJson = z.infer<typeof ChiefComplaintJsonSchema>;
