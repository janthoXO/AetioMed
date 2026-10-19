import z from "zod";

// ICD-11 stem code, anchored (it ends up in an ICD API URL path): chapter char,
// letter, digit, alphanumeric, optional `.` + 1-2 chars (`1A00`, `BA41`, `DB98.7Z`).
// Post-coordinated clusters (`&`, `/`) are out of scope.
export const ICDCodePattern = /^[0-9A-Z][A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,2})?$/;

export const ICDCodeSchema = z.stringFormat("icd", ICDCodePattern);

export type ICDCode = z.infer<typeof ICDCodeSchema>;

export const DiagnosisSchema = z.object({
  name: z.string(),
  icd: ICDCodeSchema.optional(),
  alternativeNames: z.array(z.string()).optional(),
});

export type Diagnosis = z.infer<typeof DiagnosisSchema>;
