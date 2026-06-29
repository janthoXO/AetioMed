import z from "zod";
import { asc, eq } from "drizzle-orm";
import { chunk, db, syncSource } from "../03repo/db.js";
import { predefinedItem } from "../03repo/schema.js";
import {
  readDeclaredEnglishKeys,
  resolvePredefinedList,
} from "../03repo/predefinedList.js";
import { getProcedureNameListForLanguage } from "../03repo/procedures.repo.js";
import type { Language } from "./Language.js";

export const ProcedureNameSchema = z
  .string()
  .describe("Name of the medical procedure");

export type ProcedureName = z.infer<typeof ProcedureNameSchema>;

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

export const ProcedureRelevanceSchema = z.enum([
  "obligatory",
  "optional",
  "contraindicated",
]);
export type ProcedureRelevance = z.infer<typeof ProcedureRelevanceSchema>;

export const ProcedureSchema = z.object({
  name: ProcedureNameSchema,
  relevance: ProcedureRelevanceSchema.describe(
    "Relevance of the procedure to the diagnosis"
  ),
  result: z.string().describe("Result of the procedure, if applicable"),
});

export type Procedure = z.infer<typeof ProcedureSchema>;

export function buildProcedureSchema(procedureNames?: ProcedureName[]) {
  if (procedureNames?.length) {
    return ProcedureSchema.extend({
      name: z.literal(procedureNames).describe("Name of the medical procedure"),
    });
  }
  return ProcedureSchema;
}

export function ProcedureWithIdArrayJsonExampleString(): string {
  return `[
    {
      "id": 32,
      "name": "Blood Test",
      "relevance": ${ProcedureRelevanceSchema.options
        .map((option) => `"${option}"`)
        .join(" | ")},
      "result": "Normal"
    },
    {
      "id": 68,
      "name": "X-Ray",
      "relevance": ${ProcedureRelevanceSchema.options
        .map((option) => `"${option}"`)
        .join(" | ")},
      "result": "Abnormal shadow in the left lung"
    },
  ]`;
}
