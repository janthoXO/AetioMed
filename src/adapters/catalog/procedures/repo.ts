import fs from "node:fs";
import z from "zod";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../../persistence/db.js";
import { predefinedItem } from "../../persistence/schema.js";
import { type ForeignLanguage } from "@/core/graph/shared/domain/Language.js";
import { createTranslationStore } from "../../persistence/translationStore.js";
import { catalogFile } from "../../persistence/paths.js";
import {
  leafCount,
  procedureTreeSchema,
} from "@/core/graph/shared/domain/ProcedureTree.js";
import { ReferenceBandSchema } from "@/core/graph/shared/domain/Procedure.js";
import type { ProcedureCatalogTree } from "@/core/graph/catalog/ports.js";
import { parseFhirCatalogue } from "./fhir.js";

export type ProcedureCatalogueTree = ProcedureCatalogTree;

/** FHIR R4 Bundle: catalogue tree, translations and reference bands in one file. */
export const PROCEDURES_FILE = "procedures.fhir.json";

export interface ProceduresRepo {
  /** Absolute path of the catalogue, for the startup catalogue validator. */
  readonly catalogueFile: string;
  /** Same file: translations are the concepts' designations. */
  readonly translationsFile: string;
  /** Get a node's (category or procedure) translation from English to the target language. */
  getProcedureTranslation(
    key: string,
    language: ForeignLanguage
  ): string | undefined;
  saveProcedureTranslations(
    byNodeKey: Record<string, string>,
    language: ForeignLanguage
  ): void;
  /** The catalogue tree; `undefined` = freeform, LLM invents names. */
  getProcedureTree(): ProcedureCatalogueTree | undefined;
}

const SOURCE = "procedures";
const TreeSchema = procedureTreeSchema(
  z.object({
    name: z.string().min(1),
    code: z.string().optional(),
    bands: z.array(ReferenceBandSchema).optional(),
  })
);

/** Designations as the translation store's mapping; `undefined` if malformed. */
export function fhirTranslations(parsed: unknown) {
  try {
    return parseFhirCatalogue(parsed).translations;
  } catch {
    return undefined;
  }
}

/**
 * Syncs `procedures.fhir.json` into `dbHandle`, exposes tree and translation
 * lookups. I/O here, not at import.
 */
export function createProceduresRepo(
  dbHandle: DbHandle,
  catalogDir: string
): ProceduresRepo {
  const catalogueFile = catalogFile(catalogDir, PROCEDURES_FILE);
  const translationsFile = catalogueFile;
  if (fs.existsSync(catalogFile(catalogDir, "procedures.yml")))
    console.warn(
      `[Procedure] procedures.yml is no longer read; the catalogue is ${PROCEDURES_FILE} (FHIR R4 Bundle).`
    );

  /**
   * Node (category/procedure) translations from English to other languages,
   * keyed by `nodeKey(pathIncludingOwnName)`.
   */
  const store = createTranslationStore(dbHandle, {
    name: "Procedures",
    yamlFile: translationsFile,
    parse: fhirTranslations,
  });

  function syncPredefinedProcedures() {
    const synced = dbHandle.syncSource(SOURCE, catalogueFile, (parsed) => {
      let tree;
      try {
        tree = parseFhirCatalogue(parsed).tree;
      } catch (error) {
        console.error(
          `[Procedure] Failed to load ${PROCEDURES_FILE}:\n${(error as Error).message}`
        );
        return;
      }

      dbHandle.db
        .delete(predefinedItem)
        .where(eq(predefinedItem.source, SOURCE))
        .run();

      dbHandle.db
        .insert(predefinedItem)
        .values({
          source: SOURCE,
          position: 0,
          value: JSON.stringify(tree),
        })
        .run();

      console.info(
        `[Procedure] Synced ${leafCount(tree)} predefined procedures from ${PROCEDURES_FILE}`
      );
    });

    if (!synced) {
      console.info(`[Procedure] ${PROCEDURES_FILE} unchanged, skipped parse.`);
    }
  }

  function loadProcedureTree(): ProcedureCatalogueTree | undefined {
    const row = dbHandle.db
      .select({ value: predefinedItem.value })
      .from(predefinedItem)
      .where(eq(predefinedItem.source, SOURCE))
      .get();
    if (!row) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      return undefined;
    }
    const result = TreeSchema.safeParse(parsed);
    if (!result.success) return undefined;
    return leafCount(result.data) > 0 ? result.data : undefined;
  }

  syncPredefinedProcedures();

  const procedureTree = loadProcedureTree();

  return {
    catalogueFile,
    translationsFile,
    getProcedureTranslation(key, language) {
      return store.getFromEnglish(key, language);
    },
    saveProcedureTranslations(byNodeKey, language) {
      store.save(byNodeKey, language);
    },
    getProcedureTree() {
      return procedureTree;
    },
  };
}
