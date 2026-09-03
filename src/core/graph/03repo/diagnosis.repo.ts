import { getDiagnosisByIcd, type ICDCode } from "../models/Diagnosis.js";
import { type ForeignLanguage } from "../models/Language.js";
import { createTranslationStore } from "./translationStore.js";

export async function IcdToDiagnosisName(
  icdCode: ICDCode
): Promise<string | undefined> {
  return getDiagnosisByIcd(icdCode)?.name;
}

/**
 * Diagnosis name translations.
 * Record<Language, Record<DiagnosisEnglish, DiagnosisTranslation>>
 */
const store = createTranslationStore({
  name: "Diagnosis",
  yamlFile: "data/diagnosisTranslations.yml",
});

/**
 * Get the translation of a diagnosis name to English (reverse lookup).
 */
export function getDiagnosisTranslationToEnglish(
  diagnosis: string,
  language: ForeignLanguage
): string | undefined {
  return store.getToEnglish(diagnosis, language);
}

/**
 * Save new diagnosis translations to the translation store (persisted to the
 * embedded DB, not written back to the YAML config).
 * @param englishToTarget a record mapping English diagnoses to their translations in the target language
 */
export function saveDiagnosisTranslations(
  englishToTarget: Record<string, string>,
  language: ForeignLanguage
) {
  store.save(englishToTarget, language);
}
