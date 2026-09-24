import fs from "node:fs";
import { load as parseYaml } from "js-yaml";
import { TranslationMappingSchema } from "./translationStore.js";

/**
 * Read a translations YAML (`{ Language: { EnglishTerm: Translation } }`) into
 * its raw map. Bypasses `syncSource` and the hash cache: runs every boot.
 * `yamlFile` must be absolute. Returns `{}` if missing, unparseable or wrongly shaped.
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
 * Resolve the static predefined list for a domain (anamnesis categories,
 * procedure names):
 * 1. No defaults → `undefined` (open schema; generation invents freely)
 * 2. Defaults (with or without translation keys) → use defaults
 * Translation-key validation lives in `catalog/validation.ts` +
 * `catalog/startupValidation.ts`; this stays pure. Run once at module load.
 */
export function resolvePredefinedList({
  defaults,
}: {
  defaults: string[] | undefined;
}): string[] | undefined {
  const hasDefaults = defaults !== undefined && defaults.length > 0;

  // No defaults → undefined.
  if (!hasDefaults) {
    return undefined;
  }

  // Defaults → use them.
  return defaults;
}
