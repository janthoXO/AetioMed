import { type ForeignLanguage } from "../models/Language.js";
import type { RequestContext } from "../utils/context.js";
import type { DbHandle } from "./db.js";
import { createTranslationStore } from "./translationStore.js";
import { catalogFile } from "./paths.js";

export interface LabelsRepo {
  /** Absolute path of the translations YAML, for the startup catalogue validator. */
  readonly translationsFile: string;
  /**
   * Synchronous lookup of a label's translation. Used on the trace hot path,
   * which relies on the cache having been warmed for the language beforehand.
   */
  getLabelTranslation(
    label: string,
    language: ForeignLanguage
  ): string | undefined;
  /**
   * Translate every requested label that is not already cached, in a single
   * batch (deduped across concurrent requests). Results are saved in-memory.
   */
  ensureLabelsTranslated(
    labels: string[],
    language: ForeignLanguage,
    generate: (
      missing: string[],
      lang: ForeignLanguage,
      ctx?: RequestContext
    ) => Promise<Record<string, string>>,
    ctx?: RequestContext
  ): Promise<Record<string, string>>;
}

/**
 * Syncs `labelTranslations.yml` (under `catalogDir`) into `dbHandle`'s
 * embedded database, then exposes trace-node label lookups. Pre-mapped
 * labels are preloaded from the YAML; any label not covered there is
 * translated on demand by the AI warm-up and cached (never written back to
 * the config).
 */
export function createLabelsRepo(
  dbHandle: DbHandle,
  catalogDir: string
): LabelsRepo {
  const translationsFile = catalogFile(catalogDir, "labelTranslations.yml");

  const store = createTranslationStore(dbHandle, {
    name: "Labels",
    yamlFile: translationsFile,
  });

  return {
    translationsFile,
    getLabelTranslation(label, language) {
      return store.getFromEnglish(label, language);
    },
    ensureLabelsTranslated(labels, language, generate, ctx) {
      return store.translateMissing(labels, language, generate, ctx);
    },
  };
}
