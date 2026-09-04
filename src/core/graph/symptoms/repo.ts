import { SymptomSchema, type Symptom } from "../models/Symptom.js";
import { ICDCodeSchema, type ICDCode } from "../models/Diagnosis.js";
import fs from "fs";
import z from "zod";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../persistence/db.js";
import { symptomCache } from "../persistence/schema.js";
import { catalogFile } from "../persistence/paths.js";

const SymptomMapSchema = z.record(
  ICDCodeSchema,
  z.object({
    symptoms: z.array(SymptomSchema),
  })
);

export interface SymptomsRepo {
  SymptomsRelatedToDiagnosisIcd(icdCode: ICDCode): Symptom[];
  /**
   * Return the cached LLM-generated symptoms for `icdCode`, or `undefined`
   * if there is no entry or it is older than the TTL (a miss, requiring
   * regeneration).
   */
  getCachedSymptoms(icdCode: ICDCode, nowMs?: number): Symptom[] | undefined;
  /**
   * Upsert the LLM-generated symptoms for `icdCode`, refreshing `updatedAt`
   * so the TTL window restarts from this write.
   */
  saveCachedSymptoms(icdCode: ICDCode, symptoms: Symptom[]): void;
}

function preloadDiagnosisAnamnesisMap(
  catalogDir: string
): z.infer<typeof SymptomMapSchema> {
  const filepath = catalogFile(catalogDir, "diagnosis_symptoms.json");

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

/**
 * Loads the static UMLS symptom floor (`data/diagnosis_symptoms.json`, a
 * ~2.6 MB JSON parse) and wires up the cache-aside store for LLM-generated
 * additions. All I/O happens here, not at import time.
 *
 * `symptomCacheTtlDays` is resolved by the composition root from
 * `SYMPTOM_CACHE_TTL_DAYS` (default 30) — this module never reads the
 * process environment itself.
 */
export function createSymptomsRepo(
  dbHandle: DbHandle,
  catalogDir: string,
  symptomCacheTtlDays: number
): SymptomsRepo {
  const symptomMap = preloadDiagnosisAnamnesisMap(catalogDir);
  const ttlMs = symptomCacheTtlDays * 24 * 60 * 60 * 1000;

  return {
    SymptomsRelatedToDiagnosisIcd(icdCode) {
      return symptomMap[icdCode]?.symptoms || [];
    },
    getCachedSymptoms(icdCode, nowMs = Date.now()) {
      const row = dbHandle.db
        .select()
        .from(symptomCache)
        .where(eq(symptomCache.icd, icdCode))
        .get();

      if (!row) return undefined;
      if (nowMs - row.updatedAt > ttlMs) return undefined;

      return JSON.parse(row.symptoms) as Symptom[];
    },
    saveCachedSymptoms(icdCode, symptoms) {
      const row = {
        icd: icdCode,
        symptoms: JSON.stringify(symptoms),
        updatedAt: Date.now(),
      };

      dbHandle.db
        .insert(symptomCache)
        .values(row)
        .onConflictDoUpdate({
          target: symptomCache.icd,
          set: { symptoms: row.symptoms, updatedAt: row.updatedAt },
        })
        .run();
    },
  };
}
