import z from "zod";
import { PredefinedDiagnoses, type ICDCode } from "../models/Diagnosis.js";
import {
  ForeignLanguageSchema,
  type ForeignLanguage,
} from "../models/Language.js";
import YAML from "yaml";
import fs from "fs";
import path from "path";

export async function IcdToDiagnosisName(
  icdCode: ICDCode
): Promise<string | undefined> {
  const diagnosis = PredefinedDiagnoses.find((d) => d.icd === icdCode);
  if (!diagnosis) {
    return undefined;
  }

  return diagnosis.name;
}

const LanguageDiagnosisMappingSchema = z.partialRecord(
  ForeignLanguageSchema,
  z.record(z.string(), z.string())
);

type LanguageDiagnosisMapping = z.infer<typeof LanguageDiagnosisMappingSchema>;

/**
 * Record<Language, Record<DiagnosisEnglish, DiagnosisTranslation>>
 */

// Preload translations from `src/data/diagnosisTranslations.yml` if present and `js-yaml` is available.
function preloadDiagnosisTranslations(): LanguageDiagnosisMapping {
  const dataPath = path.resolve(
    process.cwd(),
    "data/diagnosisTranslations.yml"
  );

  if (!fs.existsSync(dataPath)) {
    console.warn(
      "[Diagnosis Repo] No diagnosisTranslations.yml found, skipping preload."
    );
    return {};
  }

  try {
    const parsed = LanguageDiagnosisMappingSchema.safeParse(
      YAML.parse(fs.readFileSync(dataPath, "utf-8"))
    );
    if (!parsed.success) {
      console.warn(
        "[Diagnosis Repo] Parsed YAML is not an object, skipping preload."
      );
      return {};
    }

    console.info(
      `[Diagnosis Repo] Preloaded ${
        Object.keys(parsed.data).flatMap((k) =>
          Object.keys(parsed.data[k as keyof typeof parsed.data] || {})
        ).length
      } diagnosis translations from YAML.`
    );
    return parsed.data;
  } catch (err) {
    console.warn(
      "[Diagnosis Repo] Failed to preload diagnosis translations:",
      err
    );
    return {};
  }
}

const DiagnosisFromEnglish: LanguageDiagnosisMapping =
  preloadDiagnosisTranslations();

/**
 * Get the translation of a diagnosis name to English
 * @param diagnosis
 * @param language
 * @returns
 */
export function getDiagnosisTranslationToEnglish(
  diagnosis: string,
  language: ForeignLanguage
): string | undefined {
  const translations = DiagnosisFromEnglish[language];
  if (!translations) return undefined;

  for (const [engDiagnosis, translatedDiagnosis] of Object.entries(
    translations
  )) {
    if (translatedDiagnosis === diagnosis) {
      return engDiagnosis;
    }
  }

  return undefined;
}

/**
 * Save new diagnosis translations to the in-memory mapping
 * @param englishToTarget a record mapping English diagnoses to their translations in the target language
 * @param language the target language of the provided translations
 */
export function saveDiagnosisTranslations(
  englishToTarget: Record<string, string>,
  language: ForeignLanguage
) {
  if (!DiagnosisFromEnglish[language]) {
    DiagnosisFromEnglish[language] = {};
  }

  Object.assign(DiagnosisFromEnglish[language], englishToTarget);
}
