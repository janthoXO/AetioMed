import path from "node:path";

/**
 * `CATALOG_DIR` and `CACHE_DIR` are read directly from `process.env` here,
 * rather than through `config.ts`, and resolved once at module scope.
 *
 * That is deliberate: the repos in this directory do their file-loading work
 * at module-import time (top-level `syncSource(...)` calls etc.), which
 * happens long before `initGraph()` parses the graph config. `src/index.ts`
 * runs `import "dotenv/config"` as its very first statement, so `.env` is
 * already loaded into `process.env` before any graph module — this one
 * included — is imported. If that ordering ever changes, this module (and
 * every repo that depends on it) needs to be revisited.
 *
 * Every other module that needs a data-file path imports `CATALOG_DIR`,
 * `CACHE_DIR` or `catalogFile()` from here rather than resolving its own
 * path against `process.cwd()`.
 */

/** Deployer-owned, read-only catalogue inputs (YAML/JSON config files). */
export const CATALOG_DIR = path.resolve(
  process.cwd(),
  process.env.CATALOG_DIR ?? "data"
);

/** Generated, writable output — the embedded SQLite database lives here. */
export const CACHE_DIR = path.resolve(
  process.cwd(),
  process.env.CACHE_DIR ?? "data/cache"
);

/** Join a catalogue file name onto the resolved `CATALOG_DIR`. */
export function catalogFile(name: string): string {
  return path.join(CATALOG_DIR, name);
}
