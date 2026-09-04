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
 * Embedded SQLite cache that the various repos sync `data/*.yml` config
 * files into on startup, and query live at runtime.
 *
 * Rationale: parsing the large config files (e.g. ~37k-entry
 * diagnosisTranslations.yml) with the spec-complete `yaml` package took
 * multiple seconds on every boot. `syncSource()` below only re-parses (with
 * the much faster `js-yaml`) and re-ingests a file when its content hash has
 * changed since the last successful sync — on an unchanged file, startup
 * skips parsing entirely and the previously-synced rows are reused as-is.
 *
 * AI-generated values (e.g. on-demand translations) are written directly via
 * normal insert/upsert calls by callers (not through `syncSource`), so they
 * persist across restarts without ever being written back into the YAML
 * source files.
 */

export interface DbHandle {
  db: NodeSQLiteDatabase<typeof schema>;
  /**
   * Sync a YAML config file into the embedded DB, but only re-parse and
   * re-ingest it when its content changed since the last sync (a sha256
   * fingerprint of the raw file is stored per `source` in `_meta`).
   *
   * `ingest(parsed)` is called inside a transaction with the parsed YAML
   * document. What it does with that data is up to the caller: for plain
   * read-only lists (predefined diagnoses/procedures/anamnesis categories) a
   * full delete-then-insert is appropriate. For translation maps, `ingest`
   * should *upsert* (insert-or-overwrite) rather than delete first, so that
   * rows added at runtime for keys absent from the YAML (e.g. AI-generated
   * translations) are preserved across a YAML edit — only YAML-listed keys
   * get overwritten with the YAML's value.
   *
   * Returns `true` if a (re)sync happened, `false` if the file was missing
   * or unchanged (parse + ingest skipped entirely).
   *
   * `yamlFile` must already be an absolute path (resolved by the composition
   * root) — this function resolves nothing itself.
   */
  syncSource(
    source: string,
    yamlFile: string,
    ingest: (parsed: unknown) => void
  ): boolean;
  /**
   * SQLite binds a limited number of parameters per statement. Multi-row
   * inserts of large synced sources (e.g. ~37k translation rows) are batched
   * through this helper to stay well under that limit regardless of column
   * count, while still avoiding a separate prepared statement per row.
   */
  chunk<T>(items: T[], size?: number): T[][];
  close(): void;
}

/**
 * Opens (creating if necessary) the embedded SQLite database under
 * `cacheDir`, runs migrations, and registers process-exit handlers to close
 * it cleanly. Called once from the composition root — importing this module
 * performs no I/O by itself.
 *
 * `cacheDir` must already be an absolute path (resolved by the composition
 * root, see `app.ts`).
 */
export function createDb(cacheDir: string): DbHandle {
  const dbPath = path.join(cacheDir, "aetiomed.db");

  fs.mkdirSync(cacheDir, { recursive: true });

  const client = new DatabaseSync(dbPath);
  client.exec("PRAGMA journal_mode = WAL");
  client.exec("PRAGMA synchronous = NORMAL");

  const db = drizzle({ client, schema });

  // Drizzle migrations are application assets shipped with the code, not
  // deployer-owned data — they stay resolved against process.cwd() rather
  // than CATALOG_DIR/CACHE_DIR.
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
  process.once("beforeExit", close);
  process.once("SIGINT", () => {
    close();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    close();
    process.exit(0);
  });

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

    // The `_meta` fingerprint is keyed on `source` (a fixed domain name, e.g.
    // "diagnosis"), never on the file path — so moving CATALOG_DIR does not
    // invalidate an existing cache.
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
