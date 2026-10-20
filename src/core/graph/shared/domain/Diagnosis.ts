import z from "zod";

// ICD-11 code, anchored (it ends up in an ICD API URL path, URL-encoded).
// Stem: chapter char, letter, digit, alphanumeric, optional `.` + 1-2 chars
// (`1A00`, `BA41`, `DB98.7Z`). Optionally post-coordinated: `&` + extension
// code (`CA40.Z&XB22`, extension codes run 4-6 chars: `XB22`, `XN3SX`) or
// `/` + stem code (`1B7Y/MG51.00`). Shape only: whether the cluster is
// valid for that stem is the ICD API's call (`IcdPort.entity`).
const STEM = String.raw`[0-9A-Z][A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,2})?`;
export const ICDCodePattern = new RegExp(
  String.raw`^${STEM}(&X[0-9A-Z]{3,5}|/${STEM})*$`
);

export const ICDCodeSchema = z.stringFormat("icd", ICDCodePattern);

export type ICDCode = z.infer<typeof ICDCodeSchema>;

export const DiagnosisSchema = z.object({
  name: z.string(),
  icd: ICDCodeSchema.optional(),
  alternativeNames: z.array(z.string()).optional(),
});

export type Diagnosis = z.infer<typeof DiagnosisSchema>;
