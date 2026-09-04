import type { Diagnosis, ICDCode } from "../models/Diagnosis.js";
import type { ForeignLanguage } from "../models/Language.js";
import type { DiagnosisRepo } from "../03repo/diagnosis.repo.js";
import type { DiagnosisCatalog } from "./ports.js";

/** Reads/writes through an injected `DiagnosisRepo`. */
export class YamlDiagnosisCatalog implements DiagnosisCatalog {
  constructor(private readonly repo: DiagnosisRepo) {}

  byIcd(icd: ICDCode): Diagnosis | undefined {
    return this.repo.getDiagnosisByIcd(icd);
  }

  all(): Diagnosis[] {
    return this.repo.getAllDiagnoses();
  }

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

/** Test/injection adapter over a plain in-memory list, no persistence. */
export class InMemoryDiagnosisCatalog implements DiagnosisCatalog {
  private readonly byIcdMap = new Map<ICDCode, Diagnosis>();
  private readonly translations = new Map<
    ForeignLanguage,
    Map<string, string>
  >();

  constructor(diagnoses: Diagnosis[] = []) {
    for (const diagnosis of diagnoses) {
      if (diagnosis.icd) this.byIcdMap.set(diagnosis.icd, diagnosis);
    }
  }

  byIcd(icd: ICDCode): Diagnosis | undefined {
    return this.byIcdMap.get(icd);
  }

  all(): Diagnosis[] {
    return [...this.byIcdMap.values()];
  }

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
