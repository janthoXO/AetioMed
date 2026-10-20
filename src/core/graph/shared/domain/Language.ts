import z from "zod";

/**
 * Language set is deployment config (`LANGUAGES`, `config.ts`), not an enum.
 * A language is an ISO 639-1 code (`en`, `de`). Plain `string` aliases: bad
 * codes caught at runtime by `makeLanguageSchema`, not the type checker.
 */
export type Language = string;
export type ForeignLanguage = string;

/** Request-time language validator from configured `LANGUAGES`; `config.ts` guarantees `"en"` is in it. */
export function makeLanguageSchema(languages: readonly string[]) {
  return z.enum(languages as [string, ...string[]]);
}

const DISPLAY_NAMES = new Intl.DisplayNames(["en"], { type: "language" });

/** English name of an ISO 639-1 code (`de` -> `German`); `undefined` when unknown (`Intl` echoes those back). */
export function languageName(code: string): string | undefined {
  try {
    const name = DISPLAY_NAMES.of(code);
    return name && name !== code ? name : undefined;
  } catch {
    return undefined; // RangeError: not even a well-formed tag
  }
}

/** A language as written into a prompt: `German (de)`. Bare codes are ambiguous to a model (`no`, `it`). */
export function promptLanguage(code: string): string {
  return `${languageName(code) ?? code} (${code})`;
}
