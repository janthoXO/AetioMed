import path from "node:path";

/**
 * `CATALOG_DIR` and `CACHE_DIR` resolution. Both used to be read directly
 * from the process environment at this module's own scope; now the
 * composition root (`app.ts`) reads them once — via
 * `resolveCatalogDir`/`resolveCacheDir`, explicitly passed the environment —
 * and passes the resolved absolute paths into the `03repo/` constructors.
 * That is what lets importing a `03repo/` module perform no I/O: nothing
 * here runs until a constructor is called with an already-resolved path.
 *
 * Env variable names, defaults and resolution behaviour are unchanged from
 * before this move: `CATALOG_DIR` defaults to `"data"`, `CACHE_DIR` to
 * `"data/cache"`, both resolved against `process.cwd()`.
 */

/** Deployer-owned, read-only catalogue inputs (YAML/JSON config files). */
export function resolveCatalogDir(
  env: Record<string, string | undefined>
): string {
  return path.resolve(process.cwd(), env.CATALOG_DIR ?? "data");
}

/** Generated, writable output — the embedded SQLite database lives here. */
export function resolveCacheDir(
  env: Record<string, string | undefined>
): string {
  return path.resolve(process.cwd(), env.CACHE_DIR ?? "data/cache");
}

/** Join a catalogue file name onto an already-resolved `catalogDir`. */
export function catalogFile(catalogDir: string, name: string): string {
  return path.join(catalogDir, name);
}
