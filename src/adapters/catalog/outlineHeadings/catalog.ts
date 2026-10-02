import type { ForeignLanguage } from "@/core/graph/shared/domain/Language.js";
import type { OutlineHeadingCatalog } from "@/core/graph/catalog/ports.js";
import type { OutlineHeadingsRepo } from "./repo.js";

export class YamlOutlineHeadingCatalog implements OutlineHeadingCatalog {
  constructor(private readonly repo: OutlineHeadingsRepo) {}

  fromEnglish(title: string, lang: ForeignLanguage): string | undefined {
    return this.repo.getTranslationFromEnglish(title, lang);
  }

  saveTranslations(
    englishToTarget: Record<string, string>,
    lang: ForeignLanguage
  ): void {
    this.repo.saveTranslations(englishToTarget, lang);
  }
}

/** Test/injection adapter; optional seed `{ German: { General: "Allgemein" } }`. */
export class InMemoryOutlineHeadingCatalog implements OutlineHeadingCatalog {
  private readonly translations = new Map<
    ForeignLanguage,
    Map<string, string>
  >();

  constructor(seed: Record<ForeignLanguage, Record<string, string>> = {}) {
    for (const [lang, map] of Object.entries(seed)) {
      this.saveTranslations(map, lang);
    }
  }

  fromEnglish(title: string, lang: ForeignLanguage): string | undefined {
    return this.translations.get(lang)?.get(title);
  }

  saveTranslations(
    englishToTarget: Record<string, string>,
    lang: ForeignLanguage
  ): void {
    let map = this.translations.get(lang);
    if (!map) {
      map = new Map();
      this.translations.set(lang, map);
    }
    for (const [english, translated] of Object.entries(englishToTarget)) {
      map.set(english, translated);
    }
  }
}
