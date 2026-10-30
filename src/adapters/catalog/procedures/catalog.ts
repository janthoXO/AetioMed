import type { ProceduresRepo } from "./repo.js";
import { ProcedureCandidatesImpl } from "@/core/graph/catalog/candidates.js";
import type { ForeignLanguage } from "@/core/graph/shared/domain/Language.js";
import {
  emptyTree,
  leaves,
  refKey,
  type ProcedureRef,
} from "@/core/graph/shared/domain/ProcedureTree.js";
import type {
  CatalogProcedure,
  ProcedureCandidates,
  ProcedureCatalog,
  ProcedureCatalogTree,
} from "@/core/graph/catalog/ports.js";

/**
 * Shared `ProcedureCatalog` over a static tree (`undefined` = freeform).
 * `YamlProcedureCatalog` and `InMemoryProcedureCatalog` differ only in where
 * the tree comes from.
 */
abstract class StaticProcedureCatalog implements ProcedureCatalog {
  private readonly byRef: Map<string, CatalogProcedure>;

  constructor(
    private readonly catalogueTree: ProcedureCatalogTree | undefined
  ) {
    this.byRef = new Map(
      leaves(catalogueTree ?? emptyTree<CatalogProcedure>()).map(
        ({ path, leaf }) => [refKey({ path, name: leaf.name }), leaf]
      )
    );
  }

  tree(): ProcedureCatalogTree | undefined {
    return this.catalogueTree;
  }

  candidates(): ProcedureCandidates {
    return new ProcedureCandidatesImpl(this.catalogueTree);
  }

  procedure(ref: ProcedureRef): CatalogProcedure | undefined {
    return this.byRef.get(refKey(ref));
  }

  abstract translation(
    nodeKey: string,
    lang: ForeignLanguage
  ): string | undefined;

  abstract saveTranslations(
    byNodeKey: Record<string, string>,
    lang: ForeignLanguage
  ): void;
}

/** Reads the procedure tree from a `ProceduresRepo` once, at construction. */
export class YamlProcedureCatalog extends StaticProcedureCatalog {
  constructor(private readonly repo: ProceduresRepo) {
    super(repo.getProcedureTree());
  }

  translation(nodeKey: string, lang: ForeignLanguage): string | undefined {
    return this.repo.getProcedureTranslation(nodeKey, lang);
  }

  saveTranslations(
    byNodeKey: Record<string, string>,
    lang: ForeignLanguage
  ): void {
    this.repo.saveProcedureTranslations(byNodeKey, lang);
  }
}

/** Test/injection adapter over a plain tree (or `undefined` for freeform). */
export class InMemoryProcedureCatalog extends StaticProcedureCatalog {
  private readonly translations = new Map<
    ForeignLanguage,
    Map<string, string>
  >();

  constructor(tree?: ProcedureCatalogTree) {
    super(tree);
  }

  translation(nodeKey: string, lang: ForeignLanguage): string | undefined {
    return this.translations.get(lang)?.get(nodeKey);
  }

  saveTranslations(
    byNodeKey: Record<string, string>,
    lang: ForeignLanguage
  ): void {
    let map = this.translations.get(lang);
    if (!map) {
      map = new Map();
      this.translations.set(lang, map);
    }
    for (const [key, name] of Object.entries(byNodeKey)) map.set(key, name);
  }
}
