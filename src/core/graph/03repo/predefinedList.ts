import fs from "node:fs";
import { load as parseYaml } from "js-yaml";
import { TranslationMappingSchema } from "./translationStore.js";

/**
 * Read and parse a translations YAML file (shape:
 * `{ Language: { EnglishTerm: Translation } }`) into its raw
 * language → englishTerm → translation map.
 *
 * Reads the file directly on every call — intentionally bypasses `syncSource`
 * and the embedded-DB hash cache so this check runs on every boot regardless
 * of whether the YAML content changed since last sync.
 *
 * `yamlFile` must already be an absolute path (see `paths.ts`) — this
 * function resolves nothing itself.
 *
 * Returns `{}` if the file is missing, unparseable, or does not match the
 * expected shape.
 */
export function readDeclaredTranslations(
  yamlFile: string
): Record<string, Record<string, string> | undefined> {
  if (!fs.existsSync(yamlFile)) {
    return {};
  }

  let raw: string;
  try {
    raw = fs.readFileSync(yamlFile, "utf-8");
  } catch {
    console.warn(
      `[predefinedList] Could not read ${yamlFile}, skipping key extraction.`
    );
    return {};
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    console.warn(
      `[predefinedList] Could not parse ${yamlFile}, skipping key extraction.`
    );
    return {};
  }

  const result = TranslationMappingSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(
      `[predefinedList] ${yamlFile} did not match expected translation shape, skipping key extraction.`
    );
    return {};
  }

  return result.data;
}

/**
 * Resolve the static effective predefined list for a domain (anamnesis
 * categories, procedure names) by applying the following rules:
 *
 * 1. No defaults    → `undefined` (open schema; generation invents freely)
 * 2. Defaults only  → use defaults
 * 3. Defaults + translationKeys → use defaults; whether every translation key
 *    is actually a known default is no longer checked here. That check
 *    (Rule 3's *validation*) now lives in the startup validator
 *    (`catalog/validation.ts` + `catalog/startupValidation.ts`), which can
 *    report every offending key across every catalogue in one pass instead
 *    of `process.exit`-ing during module import on the first one found. This
 *    function stays pure so it can run (and be tested) without a process
 *    exit as a side effect.
 *
 * Run once at module load.
 */
export function resolvePredefinedList({
  defaults,
}: {
  defaults: string[] | undefined;
}): string[] | undefined {
  const hasDefaults = defaults !== undefined && defaults.length > 0;

  // Rule 1: no defaults → always undefined.
  if (!hasDefaults) {
    return undefined;
  }

  // Rules 2 & 3: defaults are provided → use them.
  return defaults;
}
