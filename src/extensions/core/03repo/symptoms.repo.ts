import { SymptomSchema, type Symptom } from "../../core/models/Symptom.js";
import { ICDCodeSchema, type ICDCode } from "../../core/models/Diagnosis.js";
import path from "path";
import fs from "fs";
import z from "zod";

const SymptomMapSchema = z.record(
  ICDCodeSchema,
  z.object({
    symptoms: z.array(SymptomSchema),
  })
);

function preloadDiagnosisAnamnesisMap(): z.infer<typeof SymptomMapSchema> {
  const filepath = path.resolve(process.cwd(), "data/diagnosis_symptoms.json");

  const translationsObject = JSON.parse(fs.readFileSync(filepath, "utf-8"));

  const parseResult = SymptomMapSchema.safeParse(translationsObject);
  if (!parseResult.success) {
    console.error("Error parsing diagnosis symptoms JSON");
    return {}; // Return empty object on parsing failure
  }

  console.info(
    `[Symptoms Repo] Loaded ${
      Object.keys(parseResult.data).flatMap((k) =>
        Object.keys(parseResult.data[k as keyof typeof parseResult.data] || {})
      ).length
    } symptom translations from JSON`
  );
  return parseResult.data;
}

const symptomMap = preloadDiagnosisAnamnesisMap();

export function SymptomsRelatedToDiagnosisIcd(icdCode: ICDCode): Symptom[] {
  return symptomMap[icdCode]?.symptoms || [];
}
