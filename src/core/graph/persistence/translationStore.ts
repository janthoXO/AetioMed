import z from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  ForeignLanguageSchema,
  type ForeignLanguage,
} from "../models/Language.js";
import type { RequestContext } from "../utils/context.js";
import { retry } from "../utils/retry.js";
import type { DbHandle } from "./db.js";
import { translation } from "./schema.js";

/**
 * SQLite-backed translation cache shared by every domain that maps known
 * English strings to a target-language equivalent (procedures, anamnesis
 * categories, diagnoses, trace labels). On creation the store syncs its YAML
 * config into the `translation` table (upserting only the keys listed in the
 * YAML — see `syncSource` in `db.ts`) and is queried live from then on. The
 * cache may be extended at runtime with AI-generated translations, which are
 * persisted to the DB so they survive restarts, but are never written back
 * to the YAML config file.
 *
 * Canonical key is always the English string; the reverse lookup
 * (`getToEnglish`) is served by an index on (domain, lang, translated).
 *
 * Two write paths, with different conflict semantics (see `source` on the
 * `translation` table):
 *  - YAML sync: `ON CONFLICT DO UPDATE` — a curated value always overwrites
 *    a previously generated one, and flips `source` back to `curated`.
 *  - runtime fill (`save()` / `translateMissing`): `ON CONFLICT DO NOTHING`,
 *    then the stored row is read back and returned — never regenerate a key
 *    that already exists, whatever its source. This is what makes
 *    convergence hold across processes/replicas, not merely within one
 *    event loop.
 */
export interface TranslationStore {
  getFromEnglish(english: string, lang: ForeignLanguage): string | undefined;
  getToEnglish(translated: string, lang: ForeignLanguage): string | undefined;
  /**
   * Runtime fill: insert every key that is not already present (first-writer
   * wins), then return the stored value for every key requested — which may
   * differ from what was passed in if another writer got there first.
   * Persisted rows are marked `source: "generated"`.
   */
  save(
    englishToTarget: Record<string, string>,
    lang: ForeignLanguage
  ): Record<string, string>;
  /**
   * Return english -> translated for every requested key, translating only the
   * keys that miss the cache. Concurrent requests share in-flight work
   * per key (not per requested set), so two overlapping requests that both
   * miss the same key trigger exactly one `generate` call for it and both
   * receive the same (persisted) value.
   *
   * Never throws: a key that cannot be translated after retries is simply
   * absent from the result, and the caller is expected to fall back to the
   * English key (as `resolveLabel` in `utils/nodeWrapper.ts` already does).
   */
  translateMissing(
    englishKeys: string[],
    lang: ForeignLanguage,
    generate: (
      missing: string[],
      lang: ForeignLanguage,
      ctx?: RequestContext
    ) => Promise<Record<string, string>>,
    ctx?: RequestContext
  ): Promise<Record<string, string>>;
}

export const TranslationMappingSchema = z.partialRecord(
  ForeignLanguageSchema,
  z.record(z.string(), z.string())
);

/** Minimal deferred-promise helper, local to this file on purpose. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function createTranslationStore(
  dbHandle: DbHandle,
  opts: {
    name: string;
    yamlFile?: string;
    /** Retry policy for runtime fills — overridable so tests don't wait out real backoff. */
    retries?: number;
    retryBaseDelayMs?: number;
  }
): TranslationStore {
  const domain = opts.name;
  const retries = opts.retries ?? 3;
  const retryBaseDelayMs = opts.retryBaseDelayMs ?? 1000;

  // Per-key in-flight dedup: `${lang}\0${english}` -> the shared promise for
  // that key's runtime fill. Must only ever be mutated synchronously between
  // reads, never across an `await`, or the whole point of this map is lost.
  const inFlight = new Map<string, Deferred<string>>();

  type Row = {
    domain: string;
    lang: string;
    english: string;
    translated: string;
  };

  /** YAML sync path: curated always overwrites, whatever was there before. */
  function upsertCurated(rows: Row[]) {
    for (const batch of dbHandle.chunk(rows)) {
      dbHandle.db
        .insert(translation)
        .values(batch.map((r) => ({ ...r, source: "curated" as const })))
        .onConflictDoUpdate({
          target: [translation.domain, translation.lang, translation.english],
          set: {
            translated: sql`excluded.translated`,
            source: sql`excluded.source`,
          },
        })
        .run();
    }
  }

  /**
   * Runtime fill path: insert-if-absent (never overwrite), then read back
   * the stored row for every requested key — which may belong to a
   * different writer (first-writer-wins) or predate this call entirely.
   */
  function insertGeneratedAndReadBack(rows: Row[]): Record<string, string> {
    if (rows.length === 0) return {};

    for (const batch of dbHandle.chunk(rows)) {
      dbHandle.db
        .insert(translation)
        .values(batch.map((r) => ({ ...r, source: "generated" as const })))
        .onConflictDoNothing()
        .run();
    }

    const result: Record<string, string> = {};
    // All rows here share the same domain/lang (see callers below).
    const { lang } = rows[0]!;
    const keys = rows.map((r) => r.english);
    for (const batch of dbHandle.chunk(keys)) {
      const stored = dbHandle.db
        .select({
          english: translation.english,
          translated: translation.translated,
        })
        .from(translation)
        .where(
          and(
            eq(translation.domain, domain),
            eq(translation.lang, lang),
            inArray(translation.english, batch)
          )
        )
        .all();
      for (const row of stored) result[row.english] = row.translated;
    }
    return result;
  }

  function getFromEnglish(english: string, lang: ForeignLanguage) {
    const row = dbHandle.db
      .select({ translated: translation.translated })
      .from(translation)
      .where(
        and(
          eq(translation.domain, domain),
          eq(translation.lang, lang),
          eq(translation.english, english)
        )
      )
      .get();
    return row?.translated;
  }

  function getToEnglish(translated: string, lang: ForeignLanguage) {
    const row = dbHandle.db
      .select({ english: translation.english })
      .from(translation)
      .where(
        and(
          eq(translation.domain, domain),
          eq(translation.lang, lang),
          eq(translation.translated, translated)
        )
      )
      .limit(1)
      .get();
    return row?.english;
  }

  function save(
    englishToTarget: Record<string, string>,
    lang: ForeignLanguage
  ): Record<string, string> {
    const rows: Row[] = Object.entries(englishToTarget).map(
      ([english, translated]) => ({ domain, lang, english, translated })
    );
    if (rows.length === 0) return {};
    return insertGeneratedAndReadBack(rows);
  }

  if (opts.yamlFile) {
    const yamlFile = opts.yamlFile;
    const synced = dbHandle.syncSource(domain, yamlFile, (parsed) => {
      const result = TranslationMappingSchema.safeParse(parsed);
      if (!result.success) {
        console.warn(
          `[${domain} Store] Could not parse ${yamlFile}, skipping sync.`
        );
        return;
      }

      const rows: Row[] = [];
      for (const lang of Object.keys(result.data) as ForeignLanguage[]) {
        const translations = result.data[lang];
        if (!translations) continue;
        for (const [english, translated] of Object.entries(translations)) {
          rows.push({ domain, lang, english, translated });
        }
      }
      upsertCurated(rows);
      console.info(
        `[${domain} Store] Synced ${rows.length} translations from YAML.`
      );
    });

    if (!synced) {
      console.info(
        `[${domain} Store] ${yamlFile} unchanged, skipped YAML parse.`
      );
    }
  }

  /**
   * Runs (and retries) exactly one `generate` call chain for `claimedKeys`,
   * resolving each key's deferred as its value is persisted, and rejecting +
   * clearing the in-flight entries for whatever is still missing once
   * retries are exhausted. Fire-and-forget from `translateMissing`'s point
   * of view — callers observe it only through the deferreds they awaited.
   */
  function scheduleFill(
    claimedKeys: string[],
    lang: ForeignLanguage,
    generate: (
      missing: string[],
      lang: ForeignLanguage,
      ctx?: RequestContext
    ) => Promise<Record<string, string>>,
    ctx: RequestContext | undefined
  ): void {
    const remaining = new Set(claimedKeys);

    const settle = (key: string, fn: (deferred: Deferred<string>) => void) => {
      const dKey = `${lang}\0${key}`;
      const deferred = inFlight.get(dKey);
      if (deferred) fn(deferred);
      inFlight.delete(dKey);
    };

    retry(
      async () => {
        const toRequest = [...remaining];
        const generated = await generate(toRequest, lang, ctx);

        // A key generate() resolves but omits is a failure for that key, not
        // a silent success with undefined — it stays in `remaining`.
        const gotRows: Row[] = [];
        for (const key of toRequest) {
          const value = generated[key];
          if (value !== undefined)
            gotRows.push({ domain, lang, english: key, translated: value });
        }

        if (gotRows.length > 0) {
          // Resolve each key as its persisted (first-writer-wins) value
          // arrives, so one stubborn key in the batch never blocks its
          // batch-mates from settling.
          const stored = insertGeneratedAndReadBack(gotRows);
          for (const [key, value] of Object.entries(stored)) {
            remaining.delete(key);
            settle(key, (d) => d.resolve(value));
          }
        }

        if (remaining.size > 0) {
          throw new Error(
            `[${domain} Store] generate() did not return a translation for: ${[...remaining].join(", ")}`
          );
        }
      },
      retries,
      retryBaseDelayMs
    ).catch((err: unknown) => {
      // Ultimate failure: reject the remaining waiters *and* delete their
      // in-flight entries, so the next request starts fresh rather than
      // inheriting a cached rejection (see extensions/persistency/redis.ts
      // for the bug this avoids).
      for (const key of remaining) {
        settle(key, (d) => d.reject(err));
      }
    });
  }

  async function translateMissing(
    englishKeys: string[],
    lang: ForeignLanguage,
    generate: (
      missing: string[],
      lang: ForeignLanguage,
      ctx?: RequestContext
    ) => Promise<Record<string, string>>,
    ctx?: RequestContext
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const missing: string[] = [];

    for (const key of englishKeys) {
      const cached = getFromEnglish(key, lang);
      if (cached !== undefined) {
        result[key] = cached;
      } else {
        missing.push(key);
      }
    }

    if (missing.length === 0) return result;

    // Synchronous claim phase — no `await` before or during this loop, so a
    // concurrently-entering request sees every deferred registered here.
    const waiters: { key: string; deferred: Deferred<string> }[] = [];
    const claimedKeys: string[] = [];
    for (const key of missing) {
      const dKey = `${lang}\0${key}`;
      let deferred = inFlight.get(dKey);
      if (!deferred) {
        deferred = createDeferred<string>();
        inFlight.set(dKey, deferred);
        claimedKeys.push(key);
      }
      waiters.push({ key, deferred });
    }

    if (claimedKeys.length > 0) {
      scheduleFill(claimedKeys, lang, generate, ctx);
    }

    // A fill failure is never fatal to the request: swallow per key here so
    // the caller gets a partial result and falls back to the English key for
    // whatever is missing, exactly as labels already do.
    await Promise.all(
      waiters.map(async ({ key, deferred }) => {
        try {
          result[key] = await deferred.promise;
        } catch {
          // Left out of `result` on purpose.
        }
      })
    );

    return result;
  }

  return {
    getFromEnglish,
    getToEnglish,
    save,
    translateMissing,
  };
}
