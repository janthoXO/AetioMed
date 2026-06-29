import { type ProcedureName } from "../models/Procedure.js";
import { type ForeignLanguage } from "../models/Language.js";
import { createTranslationStore } from "./translationStore.js";

/**
 * Procedure name translations from English to other languages.
 * e.g. { German: { "Blood Test": "Bluttest", ... } }
 */
const store = createTranslationStore({
  name: "Procedures",
  yamlFile: "data/proceduresTranslations.yml",
});

/**
 * Get the translation of a procedure from English to the target language.
 */
export function getProcedureNameTranslationFromEnglish(
  procedureName: ProcedureName,
  language: ForeignLanguage
): ProcedureName | undefined {
  return store.getFromEnglish(procedureName, language);
}

/**
 * Return all English procedure names that have a known translation for the
 * given target language. Used when no static default list is configured
 * (Rule 4): only these names will be generated so the from-English output
 * translator can always resolve them.
 */
export function getProcedureNameListForLanguage(
  language: ForeignLanguage
): ProcedureName[] {
  return store.getAllEnglishKeysForLanguage(language);
}

export function saveProcedureNameTranslation(
  englishToTarget: Record<ProcedureName, ProcedureName>,
  language: ForeignLanguage
) {
  store.save(englishToTarget, language);
}
