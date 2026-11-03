import { type Symptom } from "@/core/graph/02-plan/01-basis/symptom.js";
import fs from "fs";
import z from "zod";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../persistence/db.js";
import { symptomCache } from "../persistence/schema.js";
import { catalogFile } from "../persistence/paths.js";
import type {
  SymptomCache,
  SymptomMapping,
} from "@/core/graph/02-plan/01-basis/ports.js";

// FHIR R4 ConceptMap, lenient: only the fields read are validated. ICD code ->
// symptoms; keys are data, not request input, so not held to the ICD-11 stem shape.
const ConceptMapSchema = z.object({
  resourceType: z.literal("ConceptMap").optional(),
  group: z
    .array(
      z.object({
        element: z
          .array(
            z.object({
              code: z.string(),
              target: z
                .array(
                  z.object({
                    display: z.string().min(1).optional(),
                    equivalence: z.string().optional(),
                    comment: z.string().optional(),
                  })
                )
                .optional(),
            })
          )
          .default([]),
      })
    )
    .default([]),
});

const BundleSchema = z.object({
  resourceType: z.literal("Bundle"),
  entry: z.array(z.object({ resource: z.unknown() })).default([]),
});

/**
 * Parses a ConceptMap (bare, or inside a Bundle; other resources ignored) into
 * `ICD code -> symptoms`. Throws on a malformed ConceptMap. `{}`/null = empty.
 */
export function parseSymptomMapping(
  parsed: unknown
): Record<string, Symptom[]> {
  const bundle = BundleSchema.safeParse(parsed);
  const resources = bundle.success
    ? bundle.data.entry
        .map((e) => e.resource)
        .filter(
          (r) =>
            (r as { resourceType?: unknown } | null)?.resourceType ===
            "ConceptMap"
        )
    : [parsed ?? {}];
  const out: Record<string, Symptom[]> = {};
  for (const resource of resources)
    for (const group of ConceptMapSchema.parse(resource).group)
      for (const element of group.element)
        for (const t of element.target ?? []) {
          // FHIR R4: unmatched/disjoint mean NOT related.
          if (
            !t.display ||
            t.equivalence === "unmatched" ||
            t.equivalence === "disjoint"
          )
            continue;
          (out[element.code] ??= []).push({
            name: t.display,
            ...(t.comment && { description: t.comment }),
          });
        }
  return out;
}

export const SYMPTOMS_FILE = "symptoms.fhir.json";

/**
 * Loads the curated ICD -> symptom mapping (`data/symptoms.fhir.json`, a FHIR
 * ConceptMap). All I/O happens here, not at import time.
 */
export function createSymptomMapping(catalogDir: string): SymptomMapping {
  const filepath = catalogFile(catalogDir, SYMPTOMS_FILE);

  // Missing or empty file = no mapping; the LLM symptom provider covers every ICD.
  let symptomMap: Record<string, Symptom[]> = {};
  try {
    const raw = fs.existsSync(filepath)
      ? fs.readFileSync(filepath, "utf-8")
      : "";
    symptomMap = parseSymptomMapping(raw.trim() ? JSON.parse(raw) : {});
    console.info(
      `[Symptoms Repo] Loaded symptoms for ${Object.keys(symptomMap).length} ICD codes from ${SYMPTOMS_FILE}`
    );
  } catch (error) {
    console.error(
      `Error parsing ${SYMPTOMS_FILE}: ${(error as Error).message}`
    );
  }

  return {
    SymptomsRelatedToDiagnosisIcd(icdCode) {
      return symptomMap[icdCode] ?? [];
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
