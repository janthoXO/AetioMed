import type { DbHandle } from "../../persistence/db.js";
import { type ForeignLanguage } from "@/core/graph/shared/domain/Language.js";
import { createTranslationStore } from "../../persistence/translationStore.js";
import { catalogFile } from "../../persistence/paths.js";

export interface OutlineHeadingsRepo {
  /** Absolute path of the translations YAML, for the startup catalogue validator. */
  readonly translationsFile: string;
  getTranslationFromEnglish(
    title: string,
    language: ForeignLanguage
  ): string | undefined;
  saveTranslations(
    englishToTarget: Record<string, string>,
    language: ForeignLanguage
  ): void;
}

/**
 * Syncs `outlineHeadingsTranslations.yml` into `dbHandle`; exposes outline
 * section-title translation lookups. I/O here, not at import.
 */
export function createOutlineHeadingsRepo(
  dbHandle: DbHandle,
  catalogDir: string
): OutlineHeadingsRepo {
  const translationsFile = catalogFile(
    catalogDir,
    "outlineHeadingsTranslations.yml"
  );
  const store = createTranslationStore(dbHandle, {
    name: "OutlineHeadings",
    yamlFile: translationsFile,
  });

  return {
    translationsFile,
    getTranslationFromEnglish(title, language) {
      return store.getFromEnglish(title, language);
    },
    saveTranslations(englishToTarget, language) {
      store.save(englishToTarget, language);
    },
  };
}
