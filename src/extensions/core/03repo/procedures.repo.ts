import { type ProcedureName } from "../../core/models/Procedure.js";
import path from "node:path";
import YAML from "yaml";
import fs from "fs";
import z from "zod";
import {
  ForeignLanguageSchema,
  type ForeignLanguage,
} from "../../core/models/Language.js";

const LanguageProcedureTranslationSchema = z.partialRecord(
  ForeignLanguageSchema,
  z.record(z.string(), z.string())
);

type LanguageProcedureTranslationMapping = z.infer<
  typeof LanguageProcedureTranslationSchema
>;

function preloadProcedureNameTranslations(): LanguageProcedureTranslationMapping {
  const filepath = path.resolve(
    process.cwd(),
    "data/proceduresTranslations.yml"
  );

  if (!fs.existsSync(filepath)) {
    console.warn(
      "[Procedures Repo] No proceduresTranslations.yml found, skipping preload."
    );
    return {};
  }

  const translationsObject = YAML.parse(fs.readFileSync(filepath, "utf-8"));

  const parseResult =
    LanguageProcedureTranslationSchema.safeParse(translationsObject);
  if (!parseResult.success) {
    console.error("Error parsing procedure translations YAML");
    return {}; // Return empty object on parsing failure
  }

  console.info(
    `[Procedures Repo] Loaded ${
      Object.keys(parseResult.data).flatMap((k) =>
        Object.keys(parseResult.data[k as keyof typeof parseResult.data] || {})
      ).length
    } procedure translations from YAML`
  );
  return parseResult.data;
}

/**
 * Mapping of procedure translations from English to other languages
 *
 * e.g. { German: { "Blood Test": "Bluttest", ... } }
 */
const ProcedureTranslations: LanguageProcedureTranslationMapping =
  preloadProcedureNameTranslations();

/**
 * Get the translation of a procedure from English to the target language
 * @param category
 * @param language
 * @returns
 */
export function getProcedureNameTranslationFromEnglish(
  procedureName: ProcedureName,
  language: ForeignLanguage
): ProcedureName | undefined {
  const translatedName = ProcedureTranslations[language]?.[procedureName];
  if (translatedName) {
    return translatedName;
  }

  return undefined;
}

export function saveProcedureNameTranslation(
  englishToTarget: Record<ProcedureName, ProcedureName>,
  language: ForeignLanguage
) {
  if (!ProcedureTranslations[language]) {
    ProcedureTranslations[language] = {};
  }

  Object.assign(ProcedureTranslations[language], englishToTarget);
}
