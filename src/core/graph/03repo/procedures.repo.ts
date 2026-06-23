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

export function saveProcedureNameTranslation(
  englishToTarget: Record<ProcedureName, ProcedureName>,
  language: ForeignLanguage
) {
  store.save(englishToTarget, language);
}
