import z from "zod";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../../persistence/db.js";
import { predefinedItem } from "../../persistence/schema.js";
import { type ForeignLanguage } from "@/core/graph/models/Language.js";
import { createTranslationStore } from "../../persistence/translationStore.js";
import { catalogFile } from "../../persistence/paths.js";
import {
  leafCount,
  procedureTreeSchema,
  type ProcedureTree,
} from "@/core/graph/models/ProcedureTree.js";
import { flattenProcedureTranslations } from "./translations.js";

export type ProcedureCatalogueTree = ProcedureTree<{ name: string }>;

export interface ProceduresRepo {
  /** Absolute path of the catalogue YAML, for the startup catalogue validator. */
  readonly catalogueFile: string;
  /** Absolute path of the translations YAML, for the startup catalogue validator. */
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
const TreeSchema = procedureTreeSchema(z.object({ name: z.string().min(1) }));

/**
 * Syncs `procedures.yml` / `proceduresTranslations.yml` into `dbHandle`, exposes
 * tree and translation lookups. I/O here, not at import.
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
   * Node (category/procedure) translations from English to other languages,
   * keyed by `nodeKey(pathIncludingOwnName)`.
   */
  const store = createTranslationStore(dbHandle, {
    name: "Procedures",
    yamlFile: translationsFile,
    parse: flattenProcedureTranslations,
  });

  function syncPredefinedProcedures() {
    const synced = dbHandle.syncSource(
      SOURCE,
      catalogFile(catalogDir, "procedures.yml"),
      (parsed) => {
        const result = TreeSchema.safeParse(parsed);
        if (!result.success) {
          console.error(
            "[Procedure] Failed to load predefined procedures from YAML"
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
            value: JSON.stringify(result.data),
          })
          .run();

        console.info(
          `[Procedure] Synced ${leafCount(result.data)} predefined procedures from YAML`
        );
      }
    );

    if (!synced) {
      console.info("[Procedure] procedures.yml unchanged, skipped YAML parse.");
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
    catalogueFile: catalogFile(catalogDir, "procedures.yml"),
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
