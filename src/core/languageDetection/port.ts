/**
 * Wraps whichever offline n-gram library backs step 2 of the language ladder
 * (issue 10 §1) so it is fakeable in tests (a spy that never sees the
 * diagnosis name, only `userInstructions` — issue 10 §2) and swappable
 * later without touching `resolveLanguage.ts`.
 */
export interface LanguageDetector {
  /**
   * ISO 639-1 code plus a confidence in `[0, 1]`, or `undefined` when the
   * library has no opinion at all (e.g. the text is too short or too
   * ambiguous for it to return a candidate). A low-but-present confidence is
   * still returned — `resolveLanguage` is what applies the threshold, not
   * this port.
   */
  detect(text: string): { iso: string; confidence: number } | undefined;
}
