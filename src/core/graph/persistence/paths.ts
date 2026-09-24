import path from "node:path";

/**
 * `CATALOG_DIR` (default `"data"`) and `CACHE_DIR` (default `"data/cache"`)
 * resolution, both against `process.cwd()`. Environment is passed in by the
 * composition root; nothing runs at import.
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
