import { readDeclaredTranslations } from "../persistence/predefinedList.js";
import type { Repos } from "../repos.js";
import { getKnownLabels } from "../utils/nodeWrapper.js";
import { unmappableLanguages } from "@/core/languageDetection/mapping.js";
import {
  findUnknownKeys,
  formatProblems,
  type CatalogProblem,
} from "./validation.js";

/** Exported for direct unit testing — see `startupValidation.test.ts`. */
export interface CatalogueSpec {
  catalogue: string;
  file: string;
  baseKeys: string[];
  translations: Record<string, Record<string, string> | undefined>;
  /**
   * Whether a translation key absent from `baseKeys` is a startup error. True
   * where translations only render catalogue values (unknown key = typo); false
   * for `diagnosis`, see below.
   */
  enforceUnknownKeys: boolean;
}

function everyDiagnosisKey(repos: Repos): string[] {
  const keys: string[] = [];
  for (const diagnosis of repos.diagnosis.getAllDiagnoses()) {
    keys.push(diagnosis.name);
    for (const alt of diagnosis.alternativeNames ?? []) {
      keys.push(alt);
    }
  }
  return keys;
}

function loadCatalogueSpecs(repos: Repos): CatalogueSpec[] {
  return [
    {
      catalogue: "procedures",
      file: repos.procedures.translationsFile,
      baseKeys: repos.procedures.getEffectiveProcedureList() ?? [],
      translations: readDeclaredTranslations(repos.procedures.translationsFile),
      enforceUnknownKeys: true,
    },
    {
      catalogue: "anamnesisCategories",
      file: repos.anamnesis.translationsFile,
      baseKeys: repos.anamnesis.getEffectiveCategoryList() ?? [],
      translations: readDeclaredTranslations(repos.anamnesis.translationsFile),
      enforceUnknownKeys: true,
    },
    {
      catalogue: "diagnosis",
      file: repos.diagnosis.translationsFile,
      baseKeys: everyDiagnosisKey(repos),
      translations: readDeclaredTranslations(repos.diagnosis.translationsFile),
      // Exempt from the unknown-key rule: diagnosis store is also an input index.
      // `getDiagnosisTranslationToEnglish` (02graphs/01case-translation-to-english/tools.ts)
      // normalises user-supplied names to English, so keys outside the curated
      // `diagnosis.yml` are legitimate. `diagnosis.yml` is a curated subset,
      // `diagnosisTranslations.yml` the full ICD-11 extraction; enforcing would flag ~1500 terms.
      enforceUnknownKeys: false,
    },
    {
      catalogue: "labels",
      file: repos.labels.translationsFile,
      // `getKnownLabels()` is populated by `traceNode` while `buildCaseGraph()` runs;
      // see `validateCatalogsOrExit()` call site in `graph/index.ts`.
      baseKeys: getKnownLabels(),
      translations: readDeclaredTranslations(repos.labels.translationsFile),
      enforceUnknownKeys: true,
    },
  ];
}

/**
 * Print one summary line per catalogue: entry count, configured languages,
 * and how many keys have a translation vs fall back to English.
 *
 *   [catalog] procedures            412 entries · German: 412/412 translated
 *   [catalog] labels                 24 entries · German: 22/24 translated (2 fall back to English)
 */
function printSummary(specs: CatalogueSpec[]): void {
  for (const spec of specs) {
    const entryCount = spec.baseKeys.length;
    const languages = Object.keys(spec.translations);

    const perLanguage = languages.length
      ? languages
          .map((language) => {
            const translated = spec.baseKeys.filter(
              (key) => spec.translations[language]?.[key] !== undefined
            ).length;
            const fallback = entryCount - translated;
            const fallbackNote =
              fallback > 0 ? ` (${fallback} fall back to English)` : "";
            return `${language}: ${translated}/${entryCount} translated${fallbackNote}`;
          })
          .join(", ")
      : "no translations configured";

    const name = spec.catalogue.padEnd(20);
    const count = `${entryCount}`.padStart(6);
    console.log(`[catalog] ${name} ${count} entries · ${perLanguage}`);

    // Exempt catalogue's extra keys aren't counted above; report them so unreachable keys stay visible.
    if (!spec.enforceUnknownKeys) {
      const base = new Set(spec.baseKeys);
      const extra = new Set<string>();
      for (const byKey of Object.values(spec.translations)) {
        for (const key of Object.keys(byKey ?? {})) {
          if (!base.has(key)) extra.add(key);
        }
      }
      if (extra.size > 0) {
        console.log(
          `[catalog] ${" ".repeat(20)} ${`${extra.size}`.padStart(6)} translation keys outside the catalogue, kept for reverse lookup`
        );
      }
    }
  }
}

/** A catalogue with no translation entries at all for a configured language. */
type MissingLanguageProblem = {
  catalogue: string;
  file: string;
  language: string;
};

/**
 * Every catalogue needs at least one translation entry per configured
 * non-English language; empty/absent means the language was never wired up.
 * Diagnosis is not exempt here, only from the unknown-key check.
 */
export function findMissingLanguages(
  specs: CatalogueSpec[],
  languages: string[]
): MissingLanguageProblem[] {
  const problems: MissingLanguageProblem[] = [];
  for (const language of languages) {
    if (language === "English") continue;
    for (const spec of specs) {
      const entries = spec.translations[language];
      if (!entries || Object.keys(entries).length === 0) {
        problems.push({ catalogue: spec.catalogue, file: spec.file, language });
      }
    }
  }
  return problems;
}

export function formatMissingLanguages(
  problems: MissingLanguageProblem[]
): string {
  const byCatalogue = new Map<string, MissingLanguageProblem[]>();
  for (const problem of problems) {
    const bucket = byCatalogue.get(problem.catalogue);
    if (bucket) {
      bucket.push(problem);
    } else {
      byCatalogue.set(problem.catalogue, [problem]);
    }
  }

  const lines: string[] = [];
  for (const [catalogue, catalogueProblems] of byCatalogue) {
    const file = catalogueProblems[0]!.file;
    const languages = catalogueProblems.map((p) => p.language).join(", ");
    lines.push(
      `[${catalogue}] ${file} has no translation entries for configured language(s): ${languages}.`
    );
  }
  return lines.join("\n");
}

/**
 * A language with translation entries in some catalogue's file that is not
 * in the deployment's configured `LANGUAGES` — a deployer who added
 * translations and forgot to enable them. Warned, not failed: the file is
 * harmless, just currently unreachable.
 */
export function warnUnconfiguredLanguages(
  specs: CatalogueSpec[],
  languages: string[]
): void {
  const configured = new Set(languages);
  const unconfigured = new Set<string>();
  for (const spec of specs) {
    for (const language of Object.keys(spec.translations)) {
      if (!configured.has(language)) unconfigured.add(language);
    }
  }
  for (const language of unconfigured) {
    console.warn(
      `[catalog] Translation files declare "${language}", which is not in ` +
        `LANGUAGES — it will never be served. Add it to LANGUAGES to enable it.`
    );
  }
}

/**
 * Warn (never fail) for each configured language missing from the
 * language-detection mapping (`languageDetection/mapping.ts`). It never wins
 * auto-detect but stays usable when passed explicitly.
 */
function warnUndetectableLanguages(languages: string[]): void {
  for (const language of unmappableLanguages(languages)) {
    console.warn(
      `[catalog] "${language}" is not in the language-detector's ISO↔name mapping ` +
        `table — it will never be selected by language auto-detection, but stays ` +
        `fully usable when passed explicitly as "language".`
    );
  }
}

/**
 * Validate enforcing catalogues' translation files against their base
 * catalogue and every catalogue's coverage of configured `languages`; prints a
 * summary line per catalogue first. Prints every offending item across all
 * catalogues, then exits non-zero once.
 */
export function validateCatalogsOrExit(
  repos: Repos,
  languages: string[]
): void {
  const specs = loadCatalogueSpecs(repos);

  printSummary(specs);
  warnUnconfiguredLanguages(specs, languages);
  warnUndetectableLanguages(languages);

  const unknownKeyProblems: CatalogProblem[] = specs
    .filter((spec) => spec.enforceUnknownKeys)
    .flatMap((spec) =>
      findUnknownKeys({
        catalogue: spec.catalogue,
        file: spec.file,
        baseKeys: spec.baseKeys,
        translations: spec.translations,
      })
    );

  const missingLanguageProblems = findMissingLanguages(specs, languages);

  if (unknownKeyProblems.length === 0 && missingLanguageProblems.length === 0) {
    console.log(
      "[catalog] All translation keys resolve against their base catalogue."
    );
    return;
  }

  if (unknownKeyProblems.length > 0) {
    console.error(formatProblems(unknownKeyProblems));
  }
  if (missingLanguageProblems.length > 0) {
    console.error(formatMissingLanguages(missingLanguageProblems));
  }
  process.exit(1);
}
