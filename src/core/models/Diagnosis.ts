import fs from "fs";
import path from "path";
import yaml from "yaml";
import z from "zod";

export const ICDCodePattern = /([A-Z][0-9]{2})(\.[0-9]{1,4})?/;

export const ICDCodeSchema = z.stringFormat("icd", ICDCodePattern);

export type ICDCode = z.infer<typeof ICDCodeSchema>;

export const DiagnosisSchema = z.object({
  name: z.string(),
  icd: ICDCodeSchema.optional(),
  alternativeNames: z.array(z.string()).optional(),
});

export type Diagnosis = z.infer<typeof DiagnosisSchema>;

function preloadPredefinedDiagnoses(): Diagnosis[] | undefined {
  const DiagnosisEntrySchema = z.object({
    code: ICDCodeSchema,
    names: z.array(z.string()),
  });

  const filepath = path.resolve(
    process.cwd(),
    "data/diseases_all.yml"
  );

  const diseaseEntries = z
    .array(DiagnosisEntrySchema.optional().catch(undefined))
    .transform((entries) => entries.filter((e) => !!e))
    .safeParse(yaml.parse(fs.readFileSync(filepath, "utf-8")));

  if (!diseaseEntries.success) {
    console.error("[Diagnosis] Failed to load predefined diagnoses from YAML");
    return undefined;
  }

  console.info(
    `[Diagnosis] Loaded ${diseaseEntries.data.length} predefined diagnoses from YAML`
  );

  return diseaseEntries.data.reduce((acc, entry) => {
    if (!entry.names || entry.names.length === 0) {
      console.warn(
        `[Diagnosis] Skipping entry with code ${entry.code} due to missing names`
      );
      return acc;
    }

    return [
      ...acc,
      {
        name: entry.names[0]!,
        icd: entry.code,
        alternativeNames: entry.names.slice(1),
      },
    ];
  }, [] as Diagnosis[]);
}

export const PredefinedDiagnoses: Diagnosis[] =
  preloadPredefinedDiagnoses() || [];
