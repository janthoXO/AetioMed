import { type ProcedureName } from "@/core/models/Procedure.js";
import type { ForeignLanguage } from "@/core/models/Language.js";
import {
  getProcedureNameTranslationFromEnglish,
  saveProcedureNameTranslation,
} from "@/core/03repo/procedures.repo.js";
import { generateProceduresFromEnglish } from "@/core/03aigateway/procedures.aigateway.js";
import { getRequiredRequestContext } from "@/core/utils/context.js";

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
      getRequiredRequestContext()
    );

    Object.assign(translations, generatedTranslations);

    saveProcedureNameTranslation(generatedTranslations, language);
  }

  return translations;
}
