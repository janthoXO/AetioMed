import fs from "fs";
import path from "path";
import yaml from "yaml";
import z from "zod";

export const ICDCodePattern = /([0-9A-Z]{1,4})(\.[A-Z0-9]{1,2})?/;

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

  const filepath = path.resolve(process.cwd(), "data/diagnosis.yml");

  if (!fs.existsSync(filepath)) {
    console.warn("[Diagnosis Repo] No diagnosis.yml found, skipping preload.");
    return undefined;
  }

  const diagnosisEntries = z
    .record(ICDCodeSchema, DiagnosisEntrySchema.optional().catch(undefined))
    .transform((entries) => Object.values(entries).filter((e) => !!e))
    .safeParse(yaml.parse(fs.readFileSync(filepath, "utf-8")));

  if (!diagnosisEntries.success) {
    console.error(diagnosisEntries.error);
    console.error("[Diagnosis] Failed to load predefined diagnoses from YAML");
    return undefined;
  }

  console.info(
    `[Diagnosis] Loaded ${diagnosisEntries.data.length} predefined diagnoses from YAML`
  );

  return diagnosisEntries.data.reduce((acc, entry) => {
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
