import { detectAll } from "tinyld";
import type { LanguageDetector } from "./port.js";

/**
 * `tinyld` over `franc` (issue 10 §3): offline (pure JS, no network, no
 * native build step — so no `pnpm-workspace.yaml` `allowBuilds` entry is
 * needed), TypeScript-native, and `detectAll` returns an explicit
 * `{ lang, accuracy }[]` distribution — `accuracy` reads directly as this
 * port's `confidence` — rather than `franc`'s relative distances, which
 * would need to be renormalised into something confidence-shaped first.
 *
 * Verified against the installed package's own `.d.ts`
 * (`node_modules/tinyld/dist/tinyld.normal.node.d.ts`) and by hand:
 * `detectAll(text)` returns results sorted by descending `accuracy`, and
 * `lang` is already an ISO 639-1 code (e.g. `{ lang: "de", accuracy: 1 }`)
 * even though the separate `supportedLanguages` export lists ISO 639-3 —
 * the two are not the same alphabet, so this is not a "close enough"
 * assumption, it is what the library actually returns. Short or ambiguous
 * text yields `[]` rather than a low-confidence guess.
 *
 * The default ("normal") build/entry point (`import { detectAll } from
 * "tinyld"`) is used, not `tinyld/light` or `tinyld/heavy` — no per-request
 * tuning is needed for this use case.
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
