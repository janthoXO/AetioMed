import z from "zod";
import { asc, eq } from "drizzle-orm";
import type { DbHandle } from "./db.js";
import { predefinedItem } from "./schema.js";
import { resolvePredefinedList } from "./predefinedList.js";
import {
  type ProcedureName,
  ProcedureNameSchema,
} from "../models/Procedure.js";
import { type ForeignLanguage } from "../models/Language.js";
import { createTranslationStore } from "./translationStore.js";
import { catalogFile } from "./paths.js";

export interface ProceduresRepo {
  /** Absolute path of the translations YAML, for the startup catalogue validator. */
  readonly translationsFile: string;
  /** Get the translation of a procedure from English to the target language. */
  getProcedureNameTranslationFromEnglish(
    procedureName: ProcedureName,
    language: ForeignLanguage
  ): ProcedureName | undefined;
  saveProcedureNameTranslation(
    englishToTarget: Record<ProcedureName, ProcedureName>,
    language: ForeignLanguage
  ): void;
  /**
   * Resolve the effective procedure name list.
   *
   * - If a static default list is configured (Rules 2 & 3) it is returned.
   * - Otherwise `undefined` is returned and the LLM may invent procedure
   *   names freely.
   */
  getEffectiveProcedureList(): ProcedureName[] | undefined;
}

const SOURCE = "procedures";

/**
 * Syncs `procedures.yml` / `proceduresTranslations.yml` (under `catalogDir`)
 * into `dbHandle`'s embedded database, then exposes the effective procedure
 * list and translation lookups. All I/O happens here, not at import time.
 */
export function createProceduresRepo(
  dbHandle: DbHandle,
  catalogDir: string
): ProceduresRepo {
  const translationsFile = catalogFile(
    catalogDir,
    "proceduresTranslations.yml"
  );

  /**
   * Procedure name translations from English to other languages.
   * e.g. { German: { "Blood Test": "Bluttest", ... } }
   */
  const store = createTranslationStore(dbHandle, {
    name: "Procedures",
    yamlFile: translationsFile,
  });

  function syncPredefinedProcedures() {
    const synced = dbHandle.syncSource(
      SOURCE,
      catalogFile(catalogDir, "procedures.yml"),
      (parsed) => {
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
        dbHandle.db
          .delete(predefinedItem)
          .where(eq(predefinedItem.source, SOURCE))
          .run();

        const rows = procedureEntries.data.procedures.map(
          (value, position) => ({
            source: SOURCE,
            position,
            value,
          })
        );
        for (const batch of dbHandle.chunk(rows)) {
          dbHandle.db.insert(predefinedItem).values(batch).run();
        }

        console.info(
          `[Procedure] Synced ${procedureEntries.data.procedures.length} predefined procedures from YAML`
        );
      }
    );

    if (!synced) {
      console.info("[Procedure] procedures.yml unchanged, skipped YAML parse.");
    }
  }

  function loadPredefinedProcedures(): ProcedureName[] | undefined {
    const rows = dbHandle.db
      .select({ value: predefinedItem.value })
      .from(predefinedItem)
      .where(eq(predefinedItem.source, SOURCE))
      .orderBy(asc(predefinedItem.position))
      .all();
    return rows.length ? rows.map((row) => row.value) : undefined;
  }

  syncPredefinedProcedures();

  const predefinedProcedureNames: ProcedureName[] | undefined =
    resolvePredefinedList({
      defaults: loadPredefinedProcedures(),
    });

  return {
    translationsFile,
    getProcedureNameTranslationFromEnglish(procedureName, language) {
      return store.getFromEnglish(procedureName, language);
    },
    saveProcedureNameTranslation(englishToTarget, language) {
      store.save(englishToTarget, language);
    },
    getEffectiveProcedureList() {
      return predefinedProcedureNames;
    },
  };
}
