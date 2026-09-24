import { type ForeignLanguage } from "../../models/Language.js";
import type { RequestContext } from "../../utils/context.js";
import type { DbHandle } from "../../persistence/db.js";
import { createTranslationStore } from "../../persistence/translationStore.js";
import { catalogFile } from "../../persistence/paths.js";

export interface LabelsRepo {
  /** Absolute path of the translations YAML, for the startup catalogue validator. */
  readonly translationsFile: string;
  /** Sync lookup; trace hot path, cache must be warmed for the language first. */
  getLabelTranslation(
    label: string,
    language: ForeignLanguage
  ): string | undefined;
  /** Translate uncached labels in one batch (deduped across concurrent requests); saved in memory. */
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
 * Syncs `labelTranslations.yml` into `dbHandle`, exposes trace-node label
 * lookups. Labels missing from YAML are translated on demand by the AI warm-up
 * and cached, never written back to config.
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
