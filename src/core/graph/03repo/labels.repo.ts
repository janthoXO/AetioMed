import { type ForeignLanguage } from "../models/Language.js";
import type { RequestContext } from "../utils/context.js";
import { createTranslationStore } from "./translationStore.js";
import { catalogFile } from "./paths.js";

/** Exposed for the startup catalogue validator (`catalog/startupValidation.ts`). */
export const LABELS_TRANSLATIONS_FILE = catalogFile("labelTranslations.yml");

/**
 * Trace node label translations from English to other languages.
 * Pre-mapped labels are preloaded from `labelTranslations.yml` (under
 * `CATALOG_DIR`); any label not covered there is translated on demand by the
 * AI warm-up and cached in-memory only (never written back to the config).
 */
const store = createTranslationStore({
  name: "Labels",
  yamlFile: LABELS_TRANSLATIONS_FILE,
});

/**
 * Synchronous lookup of a label's translation. Used on the trace hot path,
 * which relies on the cache having been warmed for the language beforehand.
 */
export function getLabelTranslation(
  label: string,
  language: ForeignLanguage
): string | undefined {
  return store.getFromEnglish(label, language);
}

/**
 * Translate every requested label that is not already cached, in a single
 * batch (deduped across concurrent requests). Results are saved in-memory.
 */
export function ensureLabelsTranslated(
  labels: string[],
  language: ForeignLanguage,
  generate: (
    missing: string[],
    lang: ForeignLanguage,
    ctx?: RequestContext
  ) => Promise<Record<string, string>>,
  ctx?: RequestContext
): Promise<Record<string, string>> {
  return store.translateMissing(labels, language, generate, ctx);
}
