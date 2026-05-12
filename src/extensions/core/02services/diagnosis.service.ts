import type { ForeignLanguage } from "../models/Language.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import {
  getDiagnosisTranslationToEnglish,
  saveDiagnosisTranslations,
} from "../03repo/diagnosis.repo.js";
import { generateDiagnosisToEnglish } from "../03aigateway/diagnosis.aigateway.js";

export async function translateDiagnosisToEnglish(
  diagnosis: Diagnosis,
  language: ForeignLanguage
): Promise<Diagnosis> {
  let englishDiagnosis = getDiagnosisTranslationToEnglish(
    diagnosis.name,
    language
  );

  if (!englishDiagnosis) {
    // generate translation with AI
    englishDiagnosis = await generateDiagnosisToEnglish(
      diagnosis.name,
      language
    );

    saveDiagnosisTranslations({ [englishDiagnosis]: diagnosis.name }, language);
  }

  return {
    ...diagnosis,
    name: englishDiagnosis,
  };
}
