import { type Procedure } from "@/02domain-models/Procedure.js";
import path from "node:path";
import YAML from "yaml";
import fs from "fs";
import z from "zod";
import type { Language } from "@/02domain-models/Language.js";

const LanguageProcedureTranslationSchema = z.partialRecord(
  z.enum(["English", "German"]),
  z.record(z.string(), z.string())
);

type LanguageProcedureTranslationMapping = z.infer<
  typeof LanguageProcedureTranslationSchema
>;

function preloadProcedureTranslations(): LanguageProcedureTranslationMapping {
  const filepath = path.resolve(
    import.meta.dirname,
    "../../data/proceduresTranslations.yml"
  );

  const translationsObject = YAML.parse(fs.readFileSync(filepath, "utf-8"));

  const parseResult =
    LanguageProcedureTranslationSchema.safeParse(translationsObject);
  if (!parseResult.success) {
    console.error(
      "Error parsing procedure translations YAML:",
      parseResult.error
    );
    return {}; // Return empty object on parsing failure
  }

  console.info(
    "[Procedures] Loaded procedure translations from YAML:",
    parseResult.data
  );
  return parseResult.data;
}

/**
 * Mapping of procedure translations from English to other languages
 *
 * e.g. { German: { "Blood Test": "Bluttest", ... } }
 */
const ProcedureTranslations: LanguageProcedureTranslationMapping =
  preloadProcedureTranslations();

/**
 * Get the translation of a procedure from English to the target language
 * @param category
 * @param language
 * @returns
 */
export function getProcedureTranslationFromEnglish(
  procedure: Procedure,
  language: Language
): Procedure | undefined {
  const translatedName = ProcedureTranslations[language]?.[procedure.name];
  if (translatedName) {
    return { name: translatedName };
  }

  return undefined;
}

export function saveProcedureTranslation(
  englishProcedure: Procedure,
  translatedProcedure: Procedure,
  language: Language
) {
  if (!ProcedureTranslations[language]) {
    ProcedureTranslations[language] = {};
  }

  ProcedureTranslations[language][englishProcedure.name] =
    translatedProcedure.name;
}
