import path from "node:path";
import fs from "node:fs";
import YAML from "yaml";
import z from "zod";
import {
  ForeignLanguageSchema,
  type ForeignLanguage,
} from "../models/Language.js";
import type { RequestContext } from "../utils/context.js";

/**
 * In-memory translation cache shared by every domain that maps known English
 * strings to a target-language equivalent (procedures, anamnesis categories,
 * diagnoses, trace labels). The cache is preloaded from a YAML config and may
 * be extended at runtime with AI-generated translations — the latter are never
 * written back to the config file.
 *
 * Canonical key is always the English string; the reverse lookup
 * (`getToEnglish`) iterates the per-language map.
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

type TranslationMapping = z.infer<typeof TranslationMappingSchema>;

function preload(name: string, yamlFile?: string): TranslationMapping {
  if (!yamlFile) return {};

  const filepath = path.resolve(process.cwd(), yamlFile);
  if (!fs.existsSync(filepath)) {
    console.warn(`[${name} Store] No ${yamlFile} found, skipping preload.`);
    return {};
  }

  try {
    const parsed = TranslationMappingSchema.safeParse(
      YAML.parse(fs.readFileSync(filepath, "utf-8"))
    );
    if (!parsed.success) {
      console.warn(
        `[${name} Store] Could not parse ${yamlFile}, skipping preload.`
      );
      return {};
    }

    const count = Object.keys(parsed.data).flatMap((k) =>
      Object.keys(parsed.data[k as keyof typeof parsed.data] ?? {})
    ).length;
    console.info(`[${name} Store] Preloaded ${count} translations from YAML.`);
    return parsed.data;
  } catch (err) {
    console.warn(`[${name} Store] Failed to preload ${yamlFile}:`, err);
    return {};
  }
}

export function createTranslationStore(opts: {
  name: string;
  yamlFile?: string;
}): TranslationStore {
  const cache: TranslationMapping = preload(opts.name, opts.yamlFile);
  const inFlight = new Map<string, Promise<Record<string, string>>>();

  function getFromEnglish(english: string, lang: ForeignLanguage) {
    return cache[lang]?.[english];
  }

  function getToEnglish(translated: string, lang: ForeignLanguage) {
    const translations = cache[lang];
    if (!translations) return undefined;
    for (const [english, target] of Object.entries(translations)) {
      if (target === translated) return english;
    }
    return undefined;
  }

  function save(
    englishToTarget: Record<string, string>,
    lang: ForeignLanguage
  ) {
    Object.assign((cache[lang] ??= {}), englishToTarget);
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
