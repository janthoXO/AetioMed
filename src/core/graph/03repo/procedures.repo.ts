import z from "zod";
import { asc, eq } from "drizzle-orm";
import { chunk, db, syncSource } from "./db.js";
import { predefinedItem } from "./schema.js";
import {
  readDeclaredEnglishKeys,
  resolvePredefinedList,
} from "./predefinedList.js";
import {
  type ProcedureName,
  ProcedureNameSchema,
} from "../models/Procedure.js";
import { type ForeignLanguage, type Language } from "../models/Language.js";
import { createTranslationStore } from "./translationStore.js";

/**
 * Procedure name translations from English to other languages.
 * e.g. { German: { "Blood Test": "Bluttest", ... } }
 */
const store = createTranslationStore({
  name: "Procedures",
  yamlFile: "data/proceduresTranslations.yml",
});

/**
 * Get the translation of a procedure from English to the target language.
 */
export function getProcedureNameTranslationFromEnglish(
  procedureName: ProcedureName,
  language: ForeignLanguage
): ProcedureName | undefined {
  return store.getFromEnglish(procedureName, language);
}

/**
 * Return all English procedure names that have a known translation for the
 * given target language. Used when no static default list is configured
 * (Rule 4): only these names will be generated so the from-English output
 * translator can always resolve them.
 */
export function getProcedureNameListForLanguage(
  language: ForeignLanguage
): ProcedureName[] {
  return store.getAllEnglishKeysForLanguage(language);
}

export function saveProcedureNameTranslation(
  englishToTarget: Record<ProcedureName, ProcedureName>,
  language: ForeignLanguage
) {
  store.save(englishToTarget, language);
}

const SOURCE = "procedures";

function syncPredefinedProcedures() {
  const synced = syncSource(SOURCE, "data/procedures.yml", (parsed) => {
    const procedureEntries = z
      .object({
        procedures: ProcedureNameSchema.array(),
      })
      .safeParse(parsed);

    if (!procedureEntries.success) {
      console.error(
        "[Procedure] Failed to load predefined procedures from YAML"
      );
      return;
    }

    // Plain read-only ordered list (no runtime additions) - full replace.
    db.delete(predefinedItem).where(eq(predefinedItem.source, SOURCE)).run();

    const rows = procedureEntries.data.procedures.map((value, position) => ({
      source: SOURCE,
      position,
      value,
    }));
    for (const batch of chunk(rows)) {
      db.insert(predefinedItem).values(batch).run();
    }

    console.info(
      `[Procedure] Synced ${procedureEntries.data.procedures.length} predefined procedures from YAML`
    );
  });

  if (!synced) {
    console.info(
      "[Procedure] data/procedures.yml unchanged, skipped YAML parse."
    );
  }
}

function loadPredefinedProcedures(): ProcedureName[] | undefined {
  const rows = db
    .select({ value: predefinedItem.value })
    .from(predefinedItem)
    .where(eq(predefinedItem.source, SOURCE))
    .orderBy(asc(predefinedItem.position))
    .all();
  return rows.length ? rows.map((row) => row.value) : undefined;
}

syncPredefinedProcedures();

export const PredefinedProcedureNames: ProcedureName[] | undefined =
  resolvePredefinedList({
    defaults: loadPredefinedProcedures(),
    translationKeys: readDeclaredEnglishKeys("data/proceduresTranslations.yml"),
    label: "procedures",
  });

/**
 * Resolve the effective procedure name list for a given generation language.
 *
 * - If a static default list is configured (Rules 2 & 3) it is always returned
 *   regardless of language.
 * - If no defaults are configured but translation mappings exist for the given
 *   non-English language (Rule 4), the English keys for that language are
 *   returned so the from-English output translator can always resolve them.
 * - Otherwise `undefined` is returned and the LLM may invent procedure names freely.
 */
export function getEffectiveProcedureList(
  language?: Language
): ProcedureName[] | undefined {
  if (PredefinedProcedureNames !== undefined) {
    return PredefinedProcedureNames;
  }
  if (language && language !== "English") {
    const keys = getProcedureNameListForLanguage(language);
    return keys.length > 0 ? keys : undefined;
  }
  return undefined;
}
