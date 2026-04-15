import { type ProcedureName } from "../models/Procedure.js";
import type { ForeignLanguage } from "../models/Language.js";
import {
  getProcedureNameTranslationFromEnglish,
  saveProcedureNameTranslation,
} from "../03repo/procedures.repo.js";
import { generateProceduresFromEnglish } from "../03aigateway/procedures.aigateway.js";
import { getRequestContext } from "../utils/context.js";

export async function translateProcedureNamesFromEnglish(
  procedureNames: ProcedureName[],
  language: ForeignLanguage
): Promise<Record<ProcedureName, ProcedureName>> {
  const translations: Record<ProcedureName, ProcedureName> = {};
  const failedTranslations: ProcedureName[] = [];

  // 1. Try to get translations from the repo
  for (const procedureName of procedureNames) {
    const englishProcedure = getProcedureNameTranslationFromEnglish(
      procedureName,
      language
    );

    if (englishProcedure) {
      translations[procedureName] = englishProcedure;
    } else {
      failedTranslations.push(procedureName);
    }
  }

  // 2. For procedures that are not in the repo, use the LLM to translate
  if (failedTranslations.length > 0) {
    const generatedTranslations = await generateProceduresFromEnglish(
      failedTranslations,
      language,
      getRequestContext()
    );

    Object.assign(translations, generatedTranslations);

    saveProcedureNameTranslation(generatedTranslations, language);
  }

  return translations;
}
