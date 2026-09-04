import { readDeclaredTranslations } from "../03repo/predefinedList.js";
import type { Repos } from "../03repo/index.js";
import { getKnownLabels } from "../utils/nodeWrapper.js";
import {
  findUnknownKeys,
  formatProblems,
  type CatalogProblem,
} from "./validation.js";

interface CatalogueSpec {
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

/**
 * Validate the enforcing catalogues' translation files against their base
 * catalogue, printing a startup summary line per catalogue first. If any translation
 * file declares a key absent from its base catalogue, every offending key
 * (across every catalogue) is printed and the process exits non-zero once —
 * a deployer fixing typos should not have to restart four times.
 */
export function validateCatalogsOrExit(repos: Repos): void {
  const specs = loadCatalogueSpecs(repos);

  printSummary(specs);

  const problems: CatalogProblem[] = specs
    .filter((spec) => spec.enforceUnknownKeys)
    .flatMap((spec) =>
      findUnknownKeys({
        catalogue: spec.catalogue,
        file: spec.file,
        baseKeys: spec.baseKeys,
        translations: spec.translations,
      })
    );

  if (problems.length === 0) {
    console.log(
      "[catalog] All translation keys resolve against their base catalogue."
    );
    return;
  }

  console.error(formatProblems(problems));
  process.exit(1);
}
