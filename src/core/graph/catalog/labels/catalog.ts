import type { ForeignLanguage } from "../../models/Language.js";
import type { RequestContext } from "../../utils/context.js";
import type { LabelsRepo } from "./repo.js";
import type { LabelCatalog } from "../ports.js";

/** Reads/writes through an injected `LabelsRepo`'s translation store. */
export class YamlLabelCatalog implements LabelCatalog {
  constructor(private readonly repo: LabelsRepo) {}

  translate(label: string, lang: ForeignLanguage): string | undefined {
    return this.repo.getLabelTranslation(label, lang);
  }

  ensureTranslated(
    labels: string[],
    lang: ForeignLanguage,
    generate: (
      missing: string[],
      lang: ForeignLanguage,
      ctx?: RequestContext
    ) => Promise<Record<string, string>>,
    ctx?: RequestContext
  ): Promise<Record<string, string>> {
    return this.repo.ensureLabelsTranslated(labels, lang, generate, ctx);
  }
}

/** Test/injection adapter over a plain in-memory map, no persistence. */
export class InMemoryLabelCatalog implements LabelCatalog {
  private readonly translations = new Map<
    string,
    Map<ForeignLanguage, string>
  >();

  constructor(seed?: Record<string, Partial<Record<ForeignLanguage, string>>>) {
    if (!seed) return;
    for (const [label, byLang] of Object.entries(seed)) {
      const map = new Map<ForeignLanguage, string>();
      for (const [lang, translated] of Object.entries(byLang)) {
        if (translated !== undefined)
          map.set(lang as ForeignLanguage, translated);
      }
      this.translations.set(label, map);
    }
  }

  translate(label: string, lang: ForeignLanguage): string | undefined {
    return this.translations.get(label)?.get(lang);
  }

  async ensureTranslated(
    labels: string[],
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
    for (const label of labels) {
      const cached = this.translate(label, lang);
      if (cached !== undefined) {
        result[label] = cached;
      } else {
        missing.push(label);
      }
    }
    if (missing.length === 0) return result;

    try {
      const generated = await generate(missing, lang, ctx);
      for (const [label, translated] of Object.entries(generated)) {
        let map = this.translations.get(label);
        if (!map) {
          map = new Map();
          this.translations.set(label, map);
        }
        map.set(lang, translated);
        result[label] = translated;
      }
    } catch {
      // Never throws — matches the YAML adapter's fallback contract.
    }
    return result;
  }
}
