import z from "zod";
import { asc, eq } from "drizzle-orm";
import type { DbHandle } from "../../persistence/db.js";
import { diagnosis } from "../../persistence/schema.js";
import {
  ICDCodeSchema,
  type ICDCode,
  type Diagnosis,
} from "../../models/Diagnosis.js";
import { type ForeignLanguage } from "../../models/Language.js";
import { createTranslationStore } from "../../persistence/translationStore.js";
import { catalogFile } from "../../persistence/paths.js";

export interface DiagnosisRepo {
  /** Absolute path of the translations YAML, for the startup catalogue validator. */
  readonly translationsFile: string;
  /** Look up a predefined diagnosis by its ICD-11 code. */
  getDiagnosisByIcd(icd: ICDCode): Diagnosis | undefined;
  /** Every predefined diagnosis. Used by the `/diagnosis` listing endpoint. */
  getAllDiagnoses(): Diagnosis[];
  /** Get the translation of a diagnosis name to English (reverse lookup). */
  getDiagnosisTranslationToEnglish(
    diagnosisName: string,
    language: ForeignLanguage
  ): string | undefined;
  /**
   * Save new diagnosis translations to the translation store (persisted to
   * the embedded DB, not written back to the YAML config).
   */
  saveDiagnosisTranslations(
    englishToTarget: Record<string, string>,
    language: ForeignLanguage
  ): void;
}

function rowToDiagnosis(row: typeof diagnosis.$inferSelect): Diagnosis {
  return {
    name: row.name,
    icd: row.icd,
    alternativeNames: JSON.parse(row.alternativeNames) as string[],
  };
}

/**
 * Syncs `diagnosis.yml` / `diagnosisTranslations.yml` (under `catalogDir`)
 * into `dbHandle`'s embedded database, then exposes diagnosis lookups and
 * translations. All I/O happens here, not at import time.
 */
export function createDiagnosisRepo(
  dbHandle: DbHandle,
  catalogDir: string
): DiagnosisRepo {
  const translationsFile = catalogFile(catalogDir, "diagnosisTranslations.yml");

  /**
   * Diagnosis name translations.
   * Record<Language, Record<DiagnosisEnglish, DiagnosisTranslation>>
   */
  const store = createTranslationStore(dbHandle, {
    name: "Diagnosis",
    yamlFile: translationsFile,
  });

  function syncPredefinedDiagnoses() {
    const DiagnosisEntrySchema = z.object({
      code: ICDCodeSchema,
      names: z.array(z.string()),
    });

    const synced = dbHandle.syncSource(
      "diagnosis",
      catalogFile(catalogDir, "diagnosis.yml"),
      (parsed) => {
        const diagnosisEntries = z
          .record(
            ICDCodeSchema,
            DiagnosisEntrySchema.optional().catch(undefined)
          )
          .transform((entries) => Object.values(entries).filter((e) => !!e))
          .safeParse(parsed);

        if (!diagnosisEntries.success) {
          console.error(diagnosisEntries.error);
          console.error(
            "[Diagnosis] Failed to load predefined diagnoses from YAML"
          );
          return;
        }

        // This source is a plain read-only list (no runtime additions), so a
        // full replace is safe and keeps removed/renamed entries in sync.
        dbHandle.db.delete(diagnosis).run();

        const rows: (typeof diagnosis.$inferInsert)[] = [];
        for (const entry of diagnosisEntries.data) {
          if (!entry.names || entry.names.length === 0) {
            console.warn(
              `[Diagnosis] Skipping entry with code ${entry.code} due to missing names`
            );
            continue;
          }
          rows.push({
            icd: entry.code,
            name: entry.names[0]!,
            alternativeNames: JSON.stringify(entry.names.slice(1)),
          });
        }

        for (const batch of dbHandle.chunk(rows)) {
          dbHandle.db.insert(diagnosis).values(batch).run();
        }
        console.info(
          `[Diagnosis] Synced ${rows.length} predefined diagnoses from YAML`
        );
      }
    );

    if (!synced) {
      console.info("[Diagnosis] diagnosis.yml unchanged, skipped YAML parse.");
    }
  }

  syncPredefinedDiagnoses();

  return {
    translationsFile,
    getDiagnosisByIcd(icd) {
      const row = dbHandle.db
        .select()
        .from(diagnosis)
        .where(eq(diagnosis.icd, icd))
        .get();
      return row ? rowToDiagnosis(row) : undefined;
    },
    getAllDiagnoses() {
      return dbHandle.db
        .select()
        .from(diagnosis)
        .orderBy(asc(diagnosis.icd))
        .all()
        .map(rowToDiagnosis);
    },
    getDiagnosisTranslationToEnglish(diagnosisName, language) {
      return store.getToEnglish(diagnosisName, language);
    },
    saveDiagnosisTranslations(englishToTarget, language) {
      store.save(englishToTarget, language);
    },
  };
}
