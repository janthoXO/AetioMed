/**
 * Maps detector ISO 639-1 code to configured language *name* (`LANGUAGES`,
 * e.g. `"English"`). Only place this mapping lives.
 *
 * Convenience table, not full ISO registry. Unmapped language never wins step 2
 * (`resolveLanguage.ts`); still usable explicitly. Detection never gates.
 */
const ISO_TO_LANGUAGE_NAME: Readonly<Record<string, string>> = {
  en: "English",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  pl: "Polish",
  ru: "Russian",
  uk: "Ukrainian",
  tr: "Turkish",
  ar: "Arabic",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  sv: "Swedish",
  da: "Danish",
  no: "Norwegian",
  fi: "Finnish",
  cs: "Czech",
  sk: "Slovak",
  ro: "Romanian",
  hu: "Hungarian",
  el: "Greek",
  bg: "Bulgarian",
  hr: "Croatian",
};

/**
 * `iso` from a {@link import("./port.js").LanguageDetector} (e.g. `"de"`).
 * Returns name only if table knows code and name is in `languages`, else `undefined`.
 */
export function mapIsoToLanguage(
  iso: string,
  languages: readonly string[]
): string | undefined {
  const name = ISO_TO_LANGUAGE_NAME[iso.toLowerCase()];
  if (!name) return undefined;
  return languages.includes(name) ? name : undefined;
}

/** Configured languages the table cannot map; startup warns by name. Never win step 2. */
export function unmappableLanguages(languages: readonly string[]): string[] {
  const known = new Set(Object.values(ISO_TO_LANGUAGE_NAME));
  return languages.filter((language) => !known.has(language));
}
