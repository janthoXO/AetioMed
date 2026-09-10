// #139 — static import-boundary check. `src/core/graph/` (part of core) must
// never import from `tracing/`, `transports/` or `observability/`: those are
// adapters around core-owned ports (the `EventBus`, `core/jobEvents/`,
// `NodeTracer`/`NodeSpan`), never the other way around. This is enforced
// here as a plain source scan rather than an eslint rule so it runs with
// `pnpm test` and reports every offending file/specifier pair in one go.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const GRAPH_DIR = fileURLToPath(new URL(".", import.meta.url));

const FORBIDDEN_SPECIFIER = /(^|\/)(tracing|transports|observability)\//;
const FORBIDDEN_ALIAS_PREFIXES = [
  "@/tracing",
  "@/transports",
  "@/observability",
];

// Matches the specifier of `import ... from "x"`, `import "x"`,
// `import("x")` and `export ... from "x"` — single or double quoted.
const IMPORT_SPECIFIER_RE = /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g;

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string")
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => `${dir}${entry}`);
}

function specifiersOf(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = match[1];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function isForbidden(specifier: string): boolean {
  if (FORBIDDEN_SPECIFIER.test(specifier)) return true;
  return FORBIDDEN_ALIAS_PREFIXES.some((prefix) =>
    specifier.startsWith(prefix)
  );
}

describe("import boundary (#139) — src/core/graph/ never imports tracing/transports/observability", () => {
  it("has no offending import/export specifiers", () => {
    const files = listTsFiles(GRAPH_DIR);
    expect(files.length).toBeGreaterThan(0);

    const offenses: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const specifier of specifiersOf(source)) {
        if (isForbidden(specifier)) {
          offenses.push(`${file}: ${specifier}`);
        }
      }
    }

    expect(offenses).toEqual([]);
  });
});
