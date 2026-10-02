import {
  SymptomSchema,
  type Symptom,
} from "@/core/graph/02-plan/01-basis/symptom.js";
import { ICDCodeSchema } from "@/core/graph/shared/domain/Diagnosis.js";
import fs from "fs";
import z from "zod";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../persistence/db.js";
import { symptomCache } from "../persistence/schema.js";
import { catalogFile } from "../persistence/paths.js";
import type {
  SymptomCache,
  UmlsSymptomFloor,
} from "@/core/graph/02-plan/01-basis/ports.js";

const SymptomMapSchema = z.record(
  ICDCodeSchema,
  z.object({
    symptoms: z.array(SymptomSchema),
  })
);

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
 * ~2.6 MB JSON parse). All I/O happens here, not at import time.
 */
export function createUmlsSymptomFloor(catalogDir: string): UmlsSymptomFloor {
  const symptomMap = preloadDiagnosisAnamnesisMap(catalogDir);

  return {
    SymptomsRelatedToDiagnosisIcd(icdCode) {
      return symptomMap[icdCode]?.symptoms || [];
    },
  };
}

/**
 * Cache-aside store for LLM-generated symptoms.
 *
 * `symptomCacheTtlDays` is resolved by the composition root from
 * `SYMPTOM_CACHE_TTL_DAYS` (default 30) — this module never reads the
 * process environment itself.
 */
export function createSymptomCache(
  dbHandle: DbHandle,
  symptomCacheTtlDays: number
): SymptomCache {
  const ttlMs = symptomCacheTtlDays * 24 * 60 * 60 * 1000;

  return {
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
