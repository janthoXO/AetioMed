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

  // #141 — `observability/otel.ts` is the *only* place `@opentelemetry/*`
  // may be imported. This is a package-shaped boundary, not the
  // directory-shaped one above, so it is scanned separately and over all of
  // `src/core/` (not just `src/core/graph/`): `src/core/app.ts` is the
  // composition root that imports the *adapter* (`observability/otel.ts`)
  // without ever importing an `@opentelemetry/*` package itself — core only
  // knows the `NodeTracer`/`NodeSpan` port (`utils/nodeWrapper.ts`).
  it("no module under src/core/ imports @opentelemetry/*", () => {
    const CORE_DIR = fileURLToPath(new URL("../", import.meta.url));
    const files = listTsFiles(CORE_DIR);
    expect(files.length).toBeGreaterThan(0);

    const OTEL_SPECIFIER = /^@opentelemetry\//;
    const offenses: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const specifier of specifiersOf(source)) {
        if (OTEL_SPECIFIER.test(specifier)) {
          offenses.push(`${file}: ${specifier}`);
        }
      }
    }

    expect(offenses).toEqual([]);
  });

  // #145 — direction matters: REST depends on NATS through composition
  // (`app.ts`'s `selectJobDirectory`), never the reverse. NATS is
  // infrastructure here, not a peer, so no *production* module under
  // `src/transports/nats/` may import `src/transports/rest/`. Test files are
  // excluded on purpose: `jetstream.integration.test.ts` (#144's NATS-parity
  // block) legitimately builds a REST app to assert "the NATS endpoint
  // returns the same payload as its REST counterpart" — that is a test
  // asserting parity between the two transports, not a runtime dependency of
  // one on the other, and the distinction this rule actually cares about.
  it("no production module under src/transports/nats/ imports transports/rest", () => {
    const NATS_DIR = fileURLToPath(
      new URL("../../transports/nats/", import.meta.url)
    );
    const files = listTsFiles(NATS_DIR).filter(
      (file) => !file.endsWith(".test.ts")
    );
    expect(files.length).toBeGreaterThan(0);

    const FORBIDDEN_REST_SPECIFIER = /(^|\/)rest\//;
    const offenses: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const specifier of specifiersOf(source)) {
        if (
          FORBIDDEN_REST_SPECIFIER.test(specifier) ||
          specifier.startsWith("@/transports/rest")
        ) {
          offenses.push(`${file}: ${specifier}`);
        }
      }
    }

    expect(offenses).toEqual([]);
  });
});
