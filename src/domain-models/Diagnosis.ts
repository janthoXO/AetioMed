import z from "zod";

export const ICDCodePattern = /([A-Z][0-9]{2})(\.[0-9]{1,4})?/;

export const ICDCodeSchema = z.stringFormat("icd", ICDCodePattern);

export type ICDCode = z.infer<typeof ICDCodeSchema>;

export const DiagnosisSchema = z.object({
  name: z.string(),
  icd: ICDCodeSchema.optional(),
});

export type Diagnosis = z.infer<typeof DiagnosisSchema>;
