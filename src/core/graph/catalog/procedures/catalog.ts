import type { ProceduresRepo } from "./repo.js";
import { ProcedureCandidatesImpl } from "./candidates.js";
import type {
  ProcedureCandidates,
  ProcedureCatalog,
  ProcedureCatalogTree,
} from "../ports.js";

/**
 * Shared `ProcedureCatalog` over a static tree (`undefined` = freeform).
 * `YamlProcedureCatalog` and `InMemoryProcedureCatalog` differ only in where
 * the tree comes from.
 */
class StaticProcedureCatalog implements ProcedureCatalog {
  constructor(
    private readonly catalogueTree: ProcedureCatalogTree | undefined
  ) {}

  tree(): ProcedureCatalogTree | undefined {
    return this.catalogueTree;
  }

  candidates(): ProcedureCandidates {
    return new ProcedureCandidatesImpl(this.catalogueTree);
  }
}

/** Reads the procedure tree from a `ProceduresRepo` once, at construction. */
export class YamlProcedureCatalog extends StaticProcedureCatalog {
  constructor(repo: ProceduresRepo) {
    super(repo.getProcedureTree());
  }
}

/** Test/injection adapter over a plain tree (or `undefined` for freeform). */
export class InMemoryProcedureCatalog extends StaticProcedureCatalog {
  constructor(tree?: ProcedureCatalogTree) {
    super(tree);
  }
}
