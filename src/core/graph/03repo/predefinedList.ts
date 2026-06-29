import fs from "node:fs";
import path from "node:path";
import { load as parseYaml } from "js-yaml";
import { TranslationMappingSchema } from "./translationStore.js";

/**
 * Read the English keys declared in a translations YAML file (shape:
 * `{ Language: { EnglishTerm: Translation } }`), returning the deduped union
 * across every language section.
 *
 * Reads the file directly on every call — intentionally bypasses `syncSource`
 * and the embedded-DB hash cache so this check runs on every boot regardless
 * of whether the YAML content changed since last sync.
 *
 * Returns an empty array if the file is missing or unparseable.
 */
export function readDeclaredEnglishKeys(relativeYamlFile: string): string[] {
  const filepath = path.resolve(process.cwd(), relativeYamlFile);
  if (!fs.existsSync(filepath)) {
    return [];
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filepath, "utf-8");
  } catch {
    console.warn(
      `[predefinedList] Could not read ${relativeYamlFile}, skipping key extraction.`
    );
    return [];
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    console.warn(
      `[predefinedList] Could not parse ${relativeYamlFile}, skipping key extraction.`
    );
    return [];
  }

  const result = TranslationMappingSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(
      `[predefinedList] ${relativeYamlFile} did not match expected translation shape, skipping key extraction.`
    );
    return [];
  }

  const keys = new Set<string>();
  for (const langMap of Object.values(result.data)) {
    if (!langMap) continue;
    for (const english of Object.keys(langMap)) {
      keys.add(english);
    }
  }
  return [...keys];
}

/**
 * Validate and return the static effective predefined list for a domain
 * (anamnesis categories, procedure names) by applying the following rules:
 *
 * 1. No defaults, no translationKeys  → `undefined` (open schema; generation
 *                                       invents freely for all languages)
 * 2. Defaults only                    → use defaults
 * 3. Defaults + translationKeys       → every translation key must be a known
 *                                       default; extras → `process.exit(1)`
 * 4. translationKeys only             → `undefined` here; the effective list is
 *                                       resolved at runtime per target language
 *                                       via `getEffective*List()` in the models.
 *
 * Run once at module load. For Rule 4, call `getEffective*List(language)` from
 * the relevant model at generation time to get the language-specific English
 * keys from the translation table.
 */
export function resolvePredefinedList({
  defaults,
  translationKeys,
  label,
}: {
  defaults: string[] | undefined;
  translationKeys: string[];
  label: string;
}): string[] | undefined {
  const hasDefaults = defaults !== undefined && defaults.length > 0;
  const hasTranslations = translationKeys.length > 0;

  // Rule 1 & 4: no defaults → always undefined at the module level.
  // (Rule 4's per-language effective list is resolved at runtime.)
  if (!hasDefaults) {
    return undefined;
  }

  // Rules 2 & 3: defaults are provided.
  if (hasTranslations) {
    // Rule 3: every translation key must be a known default.
    const defaultSet = new Set(defaults);
    const extra = translationKeys.filter((k) => !defaultSet.has(k));
    if (extra.length > 0) {
      console.error(
        `[${label}] Translation file references terms not present in the default list. ` +
          `Either add them to the defaults or remove them from the translations.\n` +
          `Unknown keys: ${extra.map((k) => `"${k}"`).join(", ")}`
      );
      process.exit(1);
    }
  }

  // Rule 2 (and validated Rule 3): use defaults.
  return defaults;
}
