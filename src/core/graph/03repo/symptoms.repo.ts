import { SymptomSchema, type Symptom } from "../models/Symptom.js";
import { ICDCodeSchema, type ICDCode } from "../models/Diagnosis.js";
import path from "path";
import fs from "fs";
import z from "zod";
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { symptomCache } from "./schema.js";

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

/**
 * Cache-aside store for LLM-generated symptom additions (see `symptomCache`
 * in `schema.ts`). Deliberately separate from the UMLS floor above: this
 * caches only what the LLM contributes, keyed by ICD code, with a TTL-based
 * freshness check so stale entries are treated as a miss.
 */
const SYMPTOM_CACHE_TTL_DAYS = z.coerce
  .number()
  .default(30)
  .parse(process.env.SYMPTOM_CACHE_TTL_DAYS);
const SYMPTOM_CACHE_TTL_MS = SYMPTOM_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Return the cached LLM-generated symptoms for `icdCode`, or `undefined` if
 * there is no entry or it is older than the TTL (a miss, requiring
 * regeneration).
 */
export function getCachedSymptoms(
  icdCode: ICDCode,
  nowMs: number = Date.now()
): Symptom[] | undefined {
  const row = db
    .select()
    .from(symptomCache)
    .where(eq(symptomCache.icd, icdCode))
    .get();

  if (!row) return undefined;
  if (nowMs - row.updatedAt > SYMPTOM_CACHE_TTL_MS) return undefined;

  return JSON.parse(row.symptoms) as Symptom[];
}

/**
 * Upsert the LLM-generated symptoms for `icdCode`, refreshing `updatedAt` so
 * the TTL window restarts from this write.
 */
export function saveCachedSymptoms(
  icdCode: ICDCode,
  symptoms: Symptom[]
): void {
  const row = {
    icd: icdCode,
    symptoms: JSON.stringify(symptoms),
    updatedAt: Date.now(),
  };

  db.insert(symptomCache)
    .values(row)
    .onConflictDoUpdate({
      target: symptomCache.icd,
      set: { symptoms: row.symptoms, updatedAt: row.updatedAt },
    })
    .run();
}
