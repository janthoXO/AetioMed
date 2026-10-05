/** Offline n-gram detector backing step 2 of ladder; fakeable, swappable. */
export interface LanguageDetector {
  /**
   * ISO 639-1 code plus confidence in `[0, 1]`, or `undefined` for no opinion
   * (text too short/ambiguous). Low confidence still returned; `resolveLanguage` applies threshold.
   */
  detect(text: string): { iso: string; confidence: number } | undefined;
}
