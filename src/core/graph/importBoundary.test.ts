// Static import-boundary check. `src/core/graph/` must never import
// `tracing/`, `transports/` or `observability/`: those are adapters around
// core-owned ports (`EventBus`, `core/jobEvents/`, `NodeTracer`/`NodeSpan`).
// Plain source scan (not eslint) so it runs in `pnpm test` and lists all offenders.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
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

describe("import boundary — src/core/graph/ never imports tracing/transports/observability", () => {
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

  // `observability/otel.ts` is the only place `@opentelemetry/*` may be
  // imported. Package boundary, scanned over all of `src/core/`: `app.ts`
  // imports the adapter, never an `@opentelemetry/*` package; core knows only
  // the `NodeTracer`/`NodeSpan` port (`utils/nodeWrapper.ts`).
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

  // REST depends on NATS via composition (`app.ts`'s `selectJobDirectory`),
  // never the reverse: no production module under `src/transports/nats/` may
  // import `src/transports/rest/`. Test files excluded: NATS-parity tests
  // legitimately build a REST app to compare payloads.
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

// Hexagon (#188): core is I/O-free. Every adapter (SQLite, filesystem, LLM
// providers, tinyld) lives under `src/adapters/`, wired only by `src/app.ts`.
// `@langchain/core` is adapter-only too (the `LlmPort` hides it); `@langchain/langgraph` stays allowed: engine.
describe("import boundary — src/core/ never imports adapters or I/O packages", () => {
  it("has no offending specifiers in production modules", () => {
    const CORE_DIR = fileURLToPath(new URL("../", import.meta.url));
    const files = listTsFiles(CORE_DIR).filter(
      (file) => !file.endsWith(".test.ts")
    );
    expect(files.length).toBeGreaterThan(0);

    const EXACT = new Set([
      "fs",
      "node:fs",
      "path",
      "node:path",
      "node:sqlite",
      "tinyld",
    ]);
    const PREFIXES = [
      "@/adapters",
      "@/app",
      "drizzle-orm",
      "@langchain/core",
      "@langchain/ollama",
      "@langchain/openai",
      "@langchain/google",
    ];
    const offenses: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const specifier of specifiersOf(source)) {
        if (
          EXACT.has(specifier) ||
          /(^|\/)adapters\//.test(specifier) ||
          PREFIXES.some((prefix) => specifier.startsWith(prefix))
        ) {
          offenses.push(`${file}: ${specifier}`);
        }
      }
    }

    expect(offenses).toEqual([]);
  });
});

const SLICE_RE = /^\d{2}-[a-z-]+$/;

/** Top-level numbered slice a specifier lands in, if any (alias or relative). */
function sliceOf(file: string, specifier: string): string | undefined {
  let target: string;
  if (specifier.startsWith("@/core/graph/")) {
    target = specifier.slice("@/core/graph/".length);
  } else if (specifier.startsWith(".")) {
    target = relative(GRAPH_DIR, resolve(dirname(file), specifier));
  } else {
    return undefined;
  }
  const top = target.split(sep).join("/").split("/")[0];
  return top !== undefined && SLICE_RE.test(top) ? top : undefined;
}

describe("slice boundary — numbered slices never import each other", () => {
  it("has no import into a different top-level numbered slice", () => {
    const offenses: string[] = [];
    for (const file of listTsFiles(GRAPH_DIR)) {
      if (file.endsWith(".test.ts")) continue;
      const own = relative(GRAPH_DIR, file).split(sep)[0];
      if (own === undefined || !SLICE_RE.test(own)) continue;
      const source = readFileSync(file, "utf8");
      for (const specifier of specifiersOf(source)) {
        const target = sliceOf(file, specifier);
        if (target !== undefined && target !== own) {
          offenses.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenses).toEqual([]);
  });
});
