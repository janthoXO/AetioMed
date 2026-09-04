import z from "zod";

/**
 * The supported language set is deployment configuration (`LANGUAGES`, see
 * `config.ts`), not a source-level enum — adding a language is a config
 * change plus a translation YAML, never a source edit (issue 09 §5.1 /
 * §10.2 of `architecture-target.md`).
 *
 * That costs compile-time exhaustiveness on purpose: `Language` and
 * `ForeignLanguage` are plain `string` aliases rather than literal unions,
 * so a mistyped or unconfigured language name is caught at *runtime* — by
 * `makeLanguageSchema`, at request-validation time — not by the type
 * checker. This is the unavoidable price of runtime configurability, not an
 * oversight; lean on the runtime validation instead.
 */
export type Language = string;
export type ForeignLanguage = string;

/**
 * Builds the request-time language validator from a deployment's configured
 * `LANGUAGES` set. Requires at least one language — `config.ts` already
 * guarantees "English" is always among them.
 */
export function makeLanguageSchema(languages: readonly string[]) {
  return z.enum(languages as [string, ...string[]]);
}

/** Same as {@link makeLanguageSchema}, minus "English". */
export function makeForeignLanguageSchema(languages: readonly string[]) {
  return makeLanguageSchema(languages).exclude(["English"]);
}
