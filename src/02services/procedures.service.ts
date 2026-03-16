import { type Procedure } from "@/models/Procedure.js";
import type { Language } from "@/models/Language.js";
import {
  getProcedureTranslationFromEnglish,
  saveProcedureTranslation,
} from "@/03repo/procedures.repo.js";
import { generateProceduresFromEnglish } from "@/03aigateway/procedures.aigateway.js";

export async function translateProceduresFromEnglish(
  procedures: Procedure[],
  language: Language
): Promise<Procedure[]> {
  const translations: Procedure[] = [];
  const failedTranslations: { index: number; procedure: Procedure }[] = [];
  for (let i = 0; i < procedures.length; i++) {
    const englishProcedure = getProcedureTranslationFromEnglish(
      procedures[i]!,
      language
    );

    if (englishProcedure) {
      translations[i] = englishProcedure;
    } else {
      failedTranslations.push({ index: i, procedure: procedures[i]! });
    }
  }

  if (failedTranslations.length > 0) {
    const englishProcedures = await generateProceduresFromEnglish(
      failedTranslations.map((t) => t.procedure),
      language
    );

    for (const { index, procedure } of failedTranslations) {
      // add to translations
      translations[index] = englishProcedures[index] ?? procedure;

      // save the translation to the memory cache for future use (only if translation successful)
      if (englishProcedures[index]) {
        saveProcedureTranslation(
          englishProcedures[index]!,
          procedure,
          language
        );
      }
    }
  }

  return translations;
}
