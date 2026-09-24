import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { load as parseYaml } from "js-yaml";
import { eq } from "drizzle-orm";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import * as schema from "./schema.js";
import { meta } from "./schema.js";

/**
 * Embedded SQLite cache synced from `data/*.yml` at startup, queried live.
 * `syncSource()` re-parses (`js-yaml`) and re-ingests a file only when its
 * content hash changed; unchanged files skip parsing. AI-generated values are
 * written directly by callers, persist across restarts, never go back to YAML.
 */

export interface DbHandle {
  db: NodeSQLiteDatabase<typeof schema>;
  /**
   * Sync a YAML file into the DB when its sha256 (stored per `source` in `_meta`)
   * changed. `ingest(parsed)` runs in a transaction: read-only lists should
   * delete-then-insert; translation maps should upsert so runtime rows for keys
   * absent from YAML survive. Returns `true` if synced, `false` if missing or
   * unchanged. `yamlFile` must be absolute.
   */
  syncSource(
    source: string,
    yamlFile: string,
    ingest: (parsed: unknown) => void
  ): boolean;
  /** Batched multi-row insert helper; stays under SQLite's bound-parameter limit. */
  chunk<T>(items: T[], size?: number): T[][];
  close(): void;
}

/**
 * Opens (creating if needed) the SQLite DB under `cacheDir` and runs
 * migrations. No I/O on import. Registers no process-exit handling: shutdown
 * is owned by the composition root, which calls `close()` last. `cacheDir`
 * must be absolute.
 */
export function createDb(cacheDir: string): DbHandle {
  const dbPath = path.join(cacheDir, "aetiomed.db");

  fs.mkdirSync(cacheDir, { recursive: true });

  const client = new DatabaseSync(dbPath);
  client.exec("PRAGMA journal_mode = WAL");
  client.exec("PRAGMA synchronous = NORMAL");

  const db = drizzle({ client, schema });

  // Migrations ship with the code: resolved against process.cwd(), not CATALOG_DIR/CACHE_DIR.
  migrate(db, {
    migrationsFolder: path.resolve(process.cwd(), "drizzle"),
  });

  function close() {
    try {
      client.close();
    } catch {
      // already closed
    }
  }

  function syncSource(
    source: string,
    yamlFile: string,
    ingest: (parsed: unknown) => void
  ): boolean {
    if (!fs.existsSync(yamlFile)) {
      console.warn(`[${source}] No ${yamlFile} found, skipping sync.`);
      return false;
    }

    const raw = fs.readFileSync(yamlFile, "utf-8");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");

    // `_meta` fingerprint keyed on `source` (fixed domain name), not file path, so moving CATALOG_DIR keeps the cache.
    const existing = db
      .select()
      .from(meta)
      .where(eq(meta.source, source))
      .get();
    if (existing?.hash === hash) {
      return false;
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      console.error(`[${source}] Failed to parse ${yamlFile}:`, err);
      return false;
    }

    db.transaction(() => {
      ingest(parsed);
      db.insert(meta)
        .values({ source, hash })
        .onConflictDoUpdate({ target: meta.source, set: { hash } })
        .run();
    });

    return true;
  }

  function chunk<T>(items: T[], size = 500): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }
    return chunks;
  }

  return { db, syncSource, chunk, close };
}
