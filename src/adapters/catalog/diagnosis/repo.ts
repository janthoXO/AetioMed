import type { DbHandle } from "../../persistence/db.js";
import { type ForeignLanguage } from "@/core/graph/shared/domain/Language.js";
import { createTranslationStore } from "../../persistence/translationStore.js";
import { catalogFile } from "../../persistence/paths.js";
import { parseDiagnosisCodeSystem } from "./fhir.js";

export const DIAGNOSES_FILE = "diagnoses.fhir.json";

export interface DiagnosisRepo {
  /** Absolute path of the diagnosis names FHIR file, for the startup catalogue validator. */
  readonly translationsFile: string;
  /** Get the translation of a diagnosis name to English (reverse lookup). */
  getDiagnosisTranslationToEnglish(
    diagnosisName: string,
    language: ForeignLanguage
  ): string | undefined;
  /** Persist new translations to the embedded DB, never back to the file. */
  saveDiagnosisTranslations(
    englishToTarget: Record<string, string>,
    language: ForeignLanguage
  ): void;
}

/**
 * Syncs `diagnoses.fhir.json` into `dbHandle`, exposes translations. I/O here, not at import.
 */
export function createDiagnosisRepo(
  dbHandle: DbHandle,
  catalogDir: string
): DiagnosisRepo {
  const translationsFile = catalogFile(catalogDir, DIAGNOSES_FILE);

  /**
   * Diagnosis name translations.
   * Record<Language, Record<DiagnosisEnglish, DiagnosisTranslation>>
   */
  const store = createTranslationStore(dbHandle, {
    name: "Diagnosis",
    yamlFile: translationsFile,
    parse: parseDiagnosisCodeSystem,
  });

  return {
    translationsFile,
    getDiagnosisTranslationToEnglish(diagnosisName, language) {
      return store.getToEnglish(diagnosisName, language);
    },
    saveDiagnosisTranslations(englishToTarget, language) {
      store.save(englishToTarget, language);
    },
  };
}
