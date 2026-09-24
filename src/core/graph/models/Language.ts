import z from "zod";

/**
 * Language set is deployment config (`LANGUAGES`, `config.ts`), not an enum.
 * Plain `string` aliases: bad names caught at runtime by `makeLanguageSchema`,
 * not the type checker.
 */
export type Language = string;
export type ForeignLanguage = string;

/** Request-time language validator from configured `LANGUAGES`; `config.ts` guarantees "English" is in it. */
export function makeLanguageSchema(languages: readonly string[]) {
  return z.enum(languages as [string, ...string[]]);
}
