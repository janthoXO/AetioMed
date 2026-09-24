import { detectAll } from "tinyld";
import type { LanguageDetector } from "./port.js";

/**
 * `tinyld`: offline pure JS, no native build; `detectAll` returns `{ lang, accuracy }[]`,
 * `accuracy` maps to port `confidence`. Results sorted descending; `lang` is ISO 639-1
 * (unlike the ISO 639-3 `supportedLanguages` export). Short/ambiguous text yields `[]`.
 * Default "normal" build used.
 */
export function createTinyldDetector(): LanguageDetector {
  return {
    detect(text) {
      const [top] = detectAll(text);
      if (!top) return undefined;
      return { iso: top.lang, confidence: top.accuracy };
    },
  };
}
