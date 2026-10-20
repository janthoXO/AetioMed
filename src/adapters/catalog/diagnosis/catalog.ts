import type { ForeignLanguage } from "@/core/graph/shared/domain/Language.js";
import type { DiagnosisRepo } from "./repo.js";
import type { DiagnosisCatalog } from "@/core/graph/catalog/ports.js";

/** Reads/writes through an injected `DiagnosisRepo`. */
export class YamlDiagnosisCatalog implements DiagnosisCatalog {
  constructor(private readonly repo: DiagnosisRepo) {}

  toEnglish(diagnosis: string, lang: ForeignLanguage): string | undefined {
    return this.repo.getDiagnosisTranslationToEnglish(diagnosis, lang);
  }

  saveTranslations(
    englishToTarget: Record<string, string>,
    lang: ForeignLanguage
  ): void {
    this.repo.saveDiagnosisTranslations(englishToTarget, lang);
  }
}

/** Test/injection adapter in memory, no persistence. */
export class InMemoryDiagnosisCatalog implements DiagnosisCatalog {
  private readonly translations = new Map<
    ForeignLanguage,
    Map<string, string>
  >();

  toEnglish(diagnosis: string, lang: ForeignLanguage): string | undefined {
    return this.translations.get(lang)?.get(diagnosis);
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
      map.set(translated, english);
    }
  }
}
