import z from "zod";
import { and, eq, sql } from "drizzle-orm";
import {
  ForeignLanguageSchema,
  type ForeignLanguage,
} from "../models/Language.js";
import type { RequestContext } from "../utils/context.js";
import { chunk, db, syncSource } from "./db.js";
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
 */
export interface TranslationStore {
  getFromEnglish(english: string, lang: ForeignLanguage): string | undefined;
  getToEnglish(translated: string, lang: ForeignLanguage): string | undefined;
  save(englishToTarget: Record<string, string>, lang: ForeignLanguage): void;
  /**
   * Return english -> translated for every requested key, translating only the
   * keys that miss the cache. Concurrent identical misses share a single
   * `generate` call (in-flight dedup); results are saved before resolving.
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

const TranslationMappingSchema = z.partialRecord(
  ForeignLanguageSchema,
  z.record(z.string(), z.string())
);

export function createTranslationStore(opts: {
  name: string;
  yamlFile?: string;
}): TranslationStore {
  const domain = opts.name;
  const inFlight = new Map<string, Promise<Record<string, string>>>();

  function upsertRows(
    rows: {
      domain: string;
      lang: string;
      english: string;
      translated: string;
    }[]
  ) {
    for (const batch of chunk(rows)) {
      db.insert(translation)
        .values(batch)
        .onConflictDoUpdate({
          target: [translation.domain, translation.lang, translation.english],
          set: { translated: sql`excluded.translated` },
        })
        .run();
    }
  }

  function getFromEnglish(english: string, lang: ForeignLanguage) {
    const row = db
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
    const row = db
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
  ) {
    const rows = Object.entries(englishToTarget).map(
      ([english, translated]) => ({
        domain,
        lang,
        english,
        translated,
      })
    );
    if (rows.length === 0) return;
    upsertRows(rows);
  }

  if (opts.yamlFile) {
    const yamlFile = opts.yamlFile;
    const synced = syncSource(domain, yamlFile, (parsed) => {
      const result = TranslationMappingSchema.safeParse(parsed);
      if (!result.success) {
        console.warn(
          `[${domain} Store] Could not parse ${yamlFile}, skipping sync.`
        );
        return;
      }

      const rows: {
        domain: string;
        lang: string;
        english: string;
        translated: string;
      }[] = [];
      for (const lang of Object.keys(result.data) as ForeignLanguage[]) {
        const translations = result.data[lang];
        if (!translations) continue;
        for (const [english, translated] of Object.entries(translations)) {
          rows.push({ domain, lang, english, translated });
        }
      }
      upsertRows(rows);
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

    const dedupKey = `${lang}\0${[...missing].sort().join("\0")}`;
    let pending = inFlight.get(dedupKey);
    if (!pending) {
      pending = (async () => {
        const generated = await generate(missing, lang, ctx);
        save(generated, lang);
        return generated;
      })().finally(() => inFlight.delete(dedupKey));
      inFlight.set(dedupKey, pending);
    }

    Object.assign(result, await pending);
    return result;
  }

  return { getFromEnglish, getToEnglish, save, translateMissing };
}
