import type { ProcedureName } from "../models/Procedure.js";
import type { ProceduresRepo } from "../03repo/procedures.repo.js";
import { ProcedureCandidatesImpl } from "./procedureCandidates.js";
import {
  UNCATEGORIZED_CATEGORY,
  type ProcedureCandidates,
  type ProcedureCatalog,
  type ProcedurePickMode,
} from "./ports.js";

/**
 * Split a procedure's full name into its category and bare name, on the
 * first `": "`. Names with no such separator fall into the synthetic
 * `UNCATEGORIZED_CATEGORY` bucket, using the full name as-is.
 */
export function parseProcedureName(full: ProcedureName): {
  category: string;
  name: string;
} {
  const separatorIndex = full.indexOf(": ");
  if (separatorIndex === -1) {
    return { category: UNCATEGORIZED_CATEGORY, name: full };
  }
  return {
    category: full.slice(0, separatorIndex),
    name: full.slice(separatorIndex + 2),
  };
}

/**
 * Group a procedure list's bare names by category, in list order.
 * Uncategorized names (no `": "` prefix) are grouped under
 * `UNCATEGORIZED_CATEGORY`.
 */
function groupProcedures(
  effective: ProcedureName[]
): Map<string, ProcedureName[]> {
  const grouped = new Map<string, ProcedureName[]>();
  for (const full of effective) {
    const { category, name } = parseProcedureName(full);
    const names = grouped.get(category);
    if (names) {
      names.push(name);
    } else {
      grouped.set(category, [name]);
    }
  }
  return grouped;
}

/**
 * Shared `ProcedureCatalog` implementation over a static
 * `ProcedureName[] | undefined` effective list. `YamlProcedureCatalog` and
 * `InMemoryProcedureCatalog` differ only in where that list comes from.
 */
class StaticProcedureCatalog implements ProcedureCatalog {
  private readonly effectiveList: ProcedureName[] | undefined;
  private readonly groupedMap: Map<string, ProcedureName[]>;

  constructor(effectiveList: ProcedureName[] | undefined) {
    this.effectiveList = effectiveList;
    this.groupedMap = groupProcedures(effectiveList ?? []);
  }

  list(): ProcedureName[] | undefined {
    return this.effectiveList;
  }

  /**
   * The real (non-synthetic) procedure categories, in first-seen order. Empty
   * when no effective list is configured, or when every procedure name is
   * uncategorized (flat-list mode) — both cases signal that category-based
   * filtering isn't applicable.
   */
  categories(): string[] {
    return [...this.groupedMap.keys()].filter(
      (category) => category !== UNCATEGORIZED_CATEGORY
    );
  }

  grouped(): Map<string, ProcedureName[]> {
    return this.groupedMap;
  }

  candidates(): ProcedureCandidates {
    return new ProcedureCandidatesImpl(this.resolveMode(), this.effectiveList);
  }

  /**
   * Scope the grouped procedure map down to the selected categories, plus the
   * always-included uncategorized bucket (uncategorized procedures bypass the
   * category filter entirely). Always returns a GROUPED candidate set, even
   * when the requested categories match nothing — a scoped pick's grammar
   * shape must not silently degrade to freeform/flat.
   */
  scope(categories: string[]): ProcedureCandidates {
    const scoped = new Map<string, ProcedureName[]>();
    for (const category of categories) {
      const names = this.groupedMap.get(category);
      if (names?.length) scoped.set(category, names);
    }
    const general = this.groupedMap.get(UNCATEGORIZED_CATEGORY);
    if (general?.length) scoped.set(UNCATEGORIZED_CATEGORY, general);
    return new ProcedureCandidatesImpl(
      { kind: "grouped", grouped: scoped },
      this.effectiveList
    );
  }

  private resolveMode(): ProcedurePickMode {
    if (this.effectiveList === undefined) return { kind: "freeform" };

    const categories = this.categories();
    if (categories.length === 0) {
      return {
        kind: "flat",
        names: this.groupedMap.get(UNCATEGORIZED_CATEGORY) ?? [],
      };
    }
    return { kind: "grouped", grouped: this.groupedMap };
  }
}

/** Reads the effective procedure list from a `ProceduresRepo` once, at construction. */
export class YamlProcedureCatalog extends StaticProcedureCatalog {
  constructor(repo: ProceduresRepo) {
    super(repo.getEffectiveProcedureList());
  }
}

/** Test/injection adapter over a plain string array (or `undefined` for freeform). */
export class InMemoryProcedureCatalog extends StaticProcedureCatalog {
  constructor(names?: ProcedureName[]) {
    super(names);
  }
}
