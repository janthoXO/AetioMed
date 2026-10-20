import type { DbHandle } from "../../persistence/db.js";
import { type ForeignLanguage } from "@/core/graph/shared/domain/Language.js";
import { createTranslationStore } from "../../persistence/translationStore.js";
import { catalogFile } from "../../persistence/paths.js";

export interface DiagnosisRepo {
  /** Absolute path of the translations YAML, for the startup catalogue validator. */
  readonly translationsFile: string;
  /** Get the translation of a diagnosis name to English (reverse lookup). */
  getDiagnosisTranslationToEnglish(
    diagnosisName: string,
    language: ForeignLanguage
  ): string | undefined;
  /** Persist new translations to the embedded DB, never back to YAML. */
  saveDiagnosisTranslations(
    englishToTarget: Record<string, string>,
    language: ForeignLanguage
  ): void;
}

/**
 * Syncs `diagnosisTranslations.yml` into `dbHandle`, exposes translations. I/O here, not at import.
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
