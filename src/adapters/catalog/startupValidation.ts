import { readDeclaredTranslations } from "../persistence/predefinedList.js";
import { OUTLINE_SECTIONS } from "@/core/graph/shared/outline/segments.js";
import type { Repos } from "../repos.js";
import { getKnownLabels } from "@/core/graph/utils/nodeWrapper.js";
import {
  duplicateSiblings,
  nodeKey,
  nodePaths,
} from "@/core/graph/shared/domain/ProcedureTree.js";
import { fhirTranslations } from "./procedures/repo.js";
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

function loadCatalogueSpecs(repos: Repos, icd: boolean): CatalogueSpec[] {
  const diagnosisTranslations = readDeclaredTranslations(
    repos.diagnosis.translationsFile
  );
  return [
    {
      catalogue: "procedures",
      file: repos.procedures.translationsFile,
      baseKeys: nodePaths(
        repos.procedures.getProcedureTree() ?? {
          categories: [],
          procedures: [],
        }
      ).map(nodeKey),
      translations: readDeclaredTranslations(
        repos.procedures.translationsFile,
        fhirTranslations
      ),
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
      catalogue: "outlineHeadings",
      file: repos.outlineHeadings.translationsFile,
      baseKeys: Object.values(OUTLINE_SECTIONS),
      translations: readDeclaredTranslations(
        repos.outlineHeadings.translationsFile
      ),
      enforceUnknownKeys: true,
    },
    // With ICD, names come from ICD and the file is ignored (warned in `validateCatalogsOrExit`).
    ...(icd
      ? []
      : [
          {
            catalogue: "diagnosis",
            file: repos.diagnosis.translationsFile,
            // No base catalogue: the file's own English keys.
            baseKeys: [
              ...new Set(
                Object.values(diagnosisTranslations).flatMap((byKey) =>
                  Object.keys(byKey ?? {})
                )
              ),
            ],
            translations: diagnosisTranslations,
            // Exempt from the unknown-key rule: the file is an input index for
            // user-supplied names (`core/diagnosis/resolve.ts`), not a curated list.
            enforceUnknownKeys: false,
          },
        ]),
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
 * A translations file that declares any language needs at least one entry per
 * configured non-English language; otherwise that language was never wired up.
 * A file declaring no language at all (missing or empty) is a deliberately
 * untranslated catalogue: its keys are LLM-translated at runtime or fall back
 * to English. Diagnosis (without ICD) is not exempt here, only from the unknown-key check.
 */
export function findMissingLanguages(
  specs: CatalogueSpec[],
  languages: string[]
): MissingLanguageProblem[] {
  const problems: MissingLanguageProblem[] = [];
  for (const language of languages) {
    if (language === "en") continue;
    for (const spec of specs) {
      if (Object.keys(spec.translations).length === 0) continue;
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
 * Procedures' translation/base keys are `nodeKey(path)` — `JSON.stringify` of a
 * segment array — which is unreadable in an error message. Render it back as
 * a `Cardiology › Resting ECG` style path; falls back to the raw string if it
 * doesn't parse (should not happen for a key this module produced itself).
 */
function readableNodeKey(key: string): string {
  try {
    const path = JSON.parse(key) as unknown;
    if (Array.isArray(path) && path.every((s) => typeof s === "string")) {
      return path.join(" › ");
    }
  } catch {
    // fall through
  }
  return key;
}

/** Duplicate sibling names in the procedure catalogue, one problem per path. */
function findDuplicateProcedureSiblings(repos: Repos): CatalogProblem[] {
  const tree = repos.procedures.getProcedureTree();
  if (!tree) return [];
  return duplicateSiblings(tree).map((path) => ({
    catalogue: "procedures",
    file: repos.procedures.catalogueFile,
    language: "(all)",
    key: `duplicate sibling name: "${path.join(" › ")}"`,
  }));
}

/**
 * Validate enforcing catalogues' translation files against their base
 * catalogue and every catalogue's coverage of configured `languages`; prints a
 * summary line per catalogue first. Prints every offending item across all
 * catalogues, then exits non-zero once.
 */
export function validateCatalogsOrExit(
  repos: Repos,
  languages: string[],
  opts: { icd: boolean }
): void {
  const specs = loadCatalogueSpecs(repos, opts.icd);
  if (opts.icd) {
    const declared = readDeclaredTranslations(repos.diagnosis.translationsFile);
    if (
      Object.values(declared).some((byKey) => Object.keys(byKey ?? {}).length)
    )
      console.warn(
        "[catalog] diagnosisTranslations.yml is ignored: ICD is configured, diagnosis names come from ICD."
      );
  }

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
    )
    .map((problem) =>
      problem.catalogue === "procedures"
        ? {
            ...problem,
            key: readableNodeKey(problem.key),
            ...(problem.suggestion !== undefined
              ? { suggestion: readableNodeKey(problem.suggestion) }
              : {}),
          }
        : problem
    )
    .concat(findDuplicateProcedureSiblings(repos));

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
