/**
 * Maps a detector's ISO 639-1 code to this deployment's configured language
 * *name* (`LANGUAGES` holds display names like `"English"`/`"German"` —
 * issue 09 §1, `config.ts`). Kept in exactly **one** place, per issue 10 §3.
 *
 * Only the common cases are listed — this is a convenience table, not an
 * exhaustive ISO registry. A configured language absent from it simply
 * **never wins step 2** of the ladder (`resolveLanguage.ts`): it stays fully
 * usable when passed explicitly at step 1, and the LLM fallback at step 3
 * names languages directly rather than through ISO codes, so it is
 * unaffected. Detection is a convenience, never a gate — the tempting "fail
 * if we cannot map it" is deliberately not what this does.
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
 * `iso` as returned by a {@link import("./port.js").LanguageDetector} (ISO
 * 639-1, e.g. `"de"`). Returns the configured language name only if the
 * table knows the code *and* that name is actually in `languages` —
 * otherwise `undefined`, so callers never have to separately check
 * membership.
 */
export function mapIsoToLanguage(
  iso: string,
  languages: readonly string[]
): string | undefined {
  const name = ISO_TO_LANGUAGE_NAME[iso.toLowerCase()];
  if (!name) return undefined;
  return languages.includes(name) ? name : undefined;
}

/**
 * Every configured language the mapping table above cannot recognise —
 * startup validation (issue 10 §4) warns about these by name rather than
 * failing: such a language is still fully usable when passed explicitly, it
 * just never wins step 2 of the ladder.
 */
export function unmappableLanguages(languages: readonly string[]): string[] {
  const known = new Set(Object.values(ISO_TO_LANGUAGE_NAME));
  return languages.filter((language) => !known.has(language));
}
