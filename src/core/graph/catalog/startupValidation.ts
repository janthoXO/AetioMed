import { readDeclaredTranslations } from "../persistence/predefinedList.js";
import type { Repos } from "../repos.js";
import { getKnownLabels } from "../utils/nodeWrapper.js";
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
   * Whether a translation key absent from `baseKeys` is a startup error.
   *
   * True for every catalogue whose translations exist only to render
   * catalogue values into a target language — there, an unknown key is a
   * typo and nothing will ever look it up. See `diagnosis` below for the one
   * catalogue where that does not hold.
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
      // The one catalogue exempt from the unknown-key rule, deliberately.
      //
      // The other three stores exist only to render a catalogue value into a
      // target language, so a key outside the catalogue is dead weight at
      // best and a typo at worst. The diagnosis store is also an *input*
      // index: `getDiagnosisTranslationToEnglish`
      // (02graphs/01case-translation-to-english/tools.ts) normalises a
      // user-supplied diagnosis name into English before generation. A key
      // absent from the curated `diagnosis.yml` is therefore useful, not
      // wrong — it lets a clinician enter a term the catalogue does not
      // itself offer.
      //
      // That is not a hypothetical: `diagnosis.yml` is a curated subset while
      // `diagnosisTranslations.yml` is the full ICD-11 extraction, and the
      // two are produced by different scripts with different scope. Enforcing
      // the rule here flags ~1500 legitimate ICD-11 terms.
      enforceUnknownKeys: false,
    },
    {
      catalogue: "labels",
      file: repos.labels.translationsFile,
      // `getKnownLabels()` is populated by `traceNode` as `buildCaseGraph()`
      // constructs the graph modules. See the comment on the call site of
      // `validateCatalogsOrExit()` in `graph/index.ts` for why this is safe
      // to read here.
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

    // An exempt catalogue's extra keys are invisible to the line above, which
    // only counts catalogue entries. Report them so the exemption stays
    // honest — silently carrying 1500 unreachable keys would be a misconfig.
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
 * For every configured non-English language, every catalogue is expected to
 * carry at least one translation entry for it (issue 09 §1) — an
 * empty/absent language key in a catalogue's translation file means that
 * language was never actually wired up for it, deployer config
 * notwithstanding. Diagnosis is *not* exempt from this completeness check —
 * only from the unknown-key check above (see `loadCatalogueSpecs`'s comment
 * on `enforceUnknownKeys`): a diagnosis translation file with zero entries
 * for a configured language is exactly as much a misconfiguration as an
 * empty `procedures.yml` translation for it.
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
 * Validate the enforcing catalogues' translation files against their base
 * catalogue, and every catalogue's translation coverage against the
 * deployment's configured `languages` (issue 09 §1), printing a startup
 * summary line per catalogue first. If any translation file declares a key
 * absent from its base catalogue, or any catalogue is missing translation
 * entries entirely for a configured language, every offending item (across
 * every catalogue) is printed and the process exits non-zero once — a
 * deployer fixing typos should not have to restart four times.
 */
export function validateCatalogsOrExit(
  repos: Repos,
  languages: string[]
): void {
  const specs = loadCatalogueSpecs(repos);

  printSummary(specs);
  warnUnconfiguredLanguages(specs, languages);

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
