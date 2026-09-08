/**
 * Pure catalogue-translation validator. No filesystem access, no repo
 * imports, no `process.exit` — callers (see `startupValidation.ts`) decide
 * what to do with the problems this reports. Kept pure so it can be unit
 * tested directly over plain data.
 */

export type CatalogProblem = {
  /** e.g. "labels", "procedures", "anamnesisCategories", "diagnosis". */
  catalogue: string;
  /** The path shown to the deployer. */
  file: string;
  language: string;
  /** The offending translation key. */
  key: string;
  /** Nearest base key, only when its Levenshtein distance is <= 3. */
  suggestion?: string;
};

/**
 * Plain Levenshtein edit distance between two strings. Deliberately
 * dependency-free (~20 lines) — this only runs on the error path.
 */
function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i]![j] = Math.min(
        dist[i - 1]![j]! + 1, // deletion
        dist[i]![j - 1]! + 1, // insertion
        dist[i - 1]![j - 1]! + cost // substitution
      );
    }
  }

  return dist[rows - 1]![cols - 1]!;
}

const MAX_SUGGESTION_DISTANCE = 3;

/**
 * Nearest base key to `key` by Levenshtein distance, when that distance is
 * <= 3. Base keys whose length differs from `key`'s by more than 3 are
 * skipped before computing the distance — cheap guard, but worth having:
 * the diagnosis catalogue alone has tens of thousands of entries, and while
 * this only runs on the error path, there is no reason to pay for it when
 * the length alone rules a candidate out.
 */
export function suggestNearest(
  key: string,
  baseKeys: Iterable<string>
): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;

  for (const candidate of baseKeys) {
    if (Math.abs(candidate.length - key.length) > MAX_SUGGESTION_DISTANCE) {
      continue;
    }
    const distance = levenshtein(key, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  return bestDistance <= MAX_SUGGESTION_DISTANCE ? best : undefined;
}

/**
 * Every translation key absent from the base catalogue, across all
 * languages. An empty `baseKeys` means "not validated" (no catalogue
 * configured — freeform generation) rather than "everything is unknown",
 * so it always yields no problems.
 */
export function findUnknownKeys(args: {
  catalogue: string;
  file: string;
  baseKeys: Iterable<string>;
  /** language -> englishKey -> translation */
  translations: Record<string, Record<string, string> | undefined>;
}): CatalogProblem[] {
  const baseKeys = [...args.baseKeys];
  if (baseKeys.length === 0) return [];

  const baseKeySet = new Set(baseKeys);
  const problems: CatalogProblem[] = [];

  for (const [language, keys] of Object.entries(args.translations)) {
    if (!keys) continue;
    for (const key of Object.keys(keys)) {
      if (baseKeySet.has(key)) continue;
      const suggestion = suggestNearest(key, baseKeys);
      problems.push({
        catalogue: args.catalogue,
        file: args.file,
        language,
        key,
        ...(suggestion !== undefined ? { suggestion } : {}),
      });
    }
  }

  return problems;
}

/**
 * Format a set of problems for console output, grouped by catalogue:
 *
 * ```
 * [labels] data/labelTranslations.yml declares a key absent from the catalogue.
 *          Unknown key:  "Choosing next procedur" (German)
 *          Did you mean: "Choosing next procedure"?
 * ```
 */
export function formatProblems(problems: CatalogProblem[]): string {
  const lines: string[] = [];

  const byCatalogue = new Map<string, CatalogProblem[]>();
  for (const problem of problems) {
    const bucket = byCatalogue.get(problem.catalogue);
    if (bucket) {
      bucket.push(problem);
    } else {
      byCatalogue.set(problem.catalogue, [problem]);
    }
  }

  for (const [catalogue, catalogueProblems] of byCatalogue) {
    const file = catalogueProblems[0]!.file;
    lines.push(
      `[${catalogue}] ${file} declares a key absent from the catalogue.`
    );
    for (const problem of catalogueProblems) {
      lines.push(
        `         Unknown key:  "${problem.key}" (${problem.language})`
      );
      if (problem.suggestion) {
        lines.push(`         Did you mean: "${problem.suggestion}"?`);
      }
    }
  }

  return lines.join("\n");
}
