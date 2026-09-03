import z from "zod";
import { renderForPrompt, section } from "../utils/prompt.js";
import {
  buildProcedureSchema,
  ProcedureSchema,
  type Procedure,
  type ProcedureName,
} from "../models/Procedure.js";
import {
  UNCATEGORIZED_CATEGORY,
  type ProcedureCandidates,
  type ProcedurePickMode,
} from "./ports.js";

/**
 * Remove already-ordered procedures from a grouped candidate map, comparing
 * against the previously ordered FULL names (category prefix reunited).
 * Categories that end up empty are dropped entirely — they have nothing left
 * to offer a pick or an expansion.
 */
function excludeOrderedFromGrouped(
  grouped: Map<string, ProcedureName[]>,
  ordered: ProcedureName[]
): Map<string, ProcedureName[]> {
  if (ordered.length === 0) return grouped;
  const orderedSet = new Set(ordered);
  const filtered = new Map<string, ProcedureName[]>();
  for (const [category, names] of grouped) {
    const remaining = names.filter(
      (name) =>
        !orderedSet.has(
          category === UNCATEGORIZED_CATEGORY ? name : `${category}: ${name}`
        )
    );
    if (remaining.length) filtered.set(category, remaining);
  }
  return filtered;
}

const CATEGORY_MENU_SAMPLE_SIZE = 3;

export class ProcedureCandidatesImpl implements ProcedureCandidates {
  constructor(
    readonly mode: ProcedurePickMode,
    private readonly canonicalList: ProcedureName[] | undefined
  ) {}

  /**
   * Remove already-ordered procedures from a pick mode's candidates, so a
   * duplicate order is impossible by construction (the grammar never offers
   * them) and the candidate context shrinks as the workup progresses.
   * Freeform mode passes through unchanged — a prompt rule covers it instead.
   */
  exclude(ordered: ProcedureName[]): ProcedureCandidates {
    switch (this.mode.kind) {
      case "freeform":
        return this;
      case "flat": {
        const orderedSet = new Set(ordered);
        return new ProcedureCandidatesImpl(
          {
            kind: "flat",
            names: this.mode.names.filter((name) => !orderedSet.has(name)),
          },
          this.canonicalList
        );
      }
      case "grouped":
        return new ProcedureCandidatesImpl(
          {
            kind: "grouped",
            grouped: excludeOrderedFromGrouped(this.mode.grouped, ordered),
          },
          this.canonicalList
        );
    }
  }

  /** Whether this candidate set still has any candidates left to offer. */
  isEmpty(): boolean {
    switch (this.mode.kind) {
      case "freeform":
        return false;
      case "flat":
        return this.mode.names.length === 0;
      case "grouped":
        return this.mode.grouped.size === 0;
    }
  }

  categories(): string[] {
    if (this.mode.kind !== "grouped") return [];
    return [...this.mode.grouped.keys()].filter(
      (category) => category !== UNCATEGORIZED_CATEGORY
    );
  }

  /**
   * The grammar-constrained schema for a pick step's "procedures" field, per
   * mode — this is what's passed to `withStructuredOutput`.
   */
  grammar(): z.ZodTypeAny {
    switch (this.mode.kind) {
      case "freeform":
        return z
          .array(buildProcedureSchema())
          .describe("one or more mutually independent procedures to order now");
      case "flat":
        return z
          .array(z.literal(this.mode.names))
          .describe("exact names of the procedures to order now");
      case "grouped": {
        const shape: Record<string, z.ZodTypeAny> = {};
        for (const [category, names] of this.mode.grouped) {
          shape[category] = z
            .array(z.literal(names))
            .optional()
            .describe(
              `procedure names (without category prefix) to order from "${category}"`
            );
        }
        return z
          .object(shape)
          .describe("procedures to order now, grouped by category key");
      }
    }
  }

  /**
   * Generic, name-agnostic counterpart to {@link grammar} used ONLY for the
   * system prompt's "Output format" example — kept free of the actual
   * (potentially large) approved-name literals so the system prompt stays
   * short and stable; the real constraint is applied via the grammar schema
   * instead.
   */
  promptSchema(): z.ZodTypeAny {
    switch (this.mode.kind) {
      case "freeform":
        return z
          .array(ProcedureSchema)
          .describe("one or more mutually independent procedures to order now");
      case "flat":
        return z
          .array(z.string())
          .describe("exact procedure names to order now");
      case "grouped":
        return z
          .record(z.string(), z.array(z.string()))
          .describe(
            "procedure names (without category prefix), keyed by category"
          );
    }
  }

  /** Renders the "Approved procedure list" prompt section for this mode. */
  render(): string | undefined {
    switch (this.mode.kind) {
      case "freeform":
        return undefined;
      case "flat":
        return section(
          "Approved procedure list (RESTRICTED WORKUP)",
          `You MUST ONLY select procedures from the following list, using their exact names. Do not invent or recommend any procedures not explicitly listed below:
${this.mode.names.map((n) => `- ${n}`).join("\n")}`
        );
      case "grouped":
        return section(
          "Approved procedure list, grouped by category (RESTRICTED WORKUP)",
          `You MUST ONLY select procedures from the categories below, using their exact names WITHOUT the category prefix — place each name under its correct category key in your response. Do not invent or recommend any procedures not explicitly listed below:
${renderForPrompt(Object.fromEntries(this.mode.grouped))}`
        );
    }
  }

  /**
   * Renders one line per real category with a size hint and a few sample
   * procedure names, so a category-level pick is informed rather than
   * name-only. Expects an already duplicate-filtered grouped map, so fully
   * ordered categories disappear from the menu. When `only` is given, renders
   * just those categories instead of every real category in the set.
   */
  categoryMenu(only?: string[]): string {
    const grouped =
      this.mode.kind === "grouped"
        ? this.mode.grouped
        : new Map<string, ProcedureName[]>();
    const entries: [string, ProcedureName[]][] = only
      ? only.map((category) => [category, grouped.get(category) ?? []])
      : [...grouped.entries()];
    return entries
      .filter(([category]) => category !== UNCATEGORIZED_CATEGORY)
      .map(([category, names]) => {
        const sample = names.slice(0, CATEGORY_MENU_SAMPLE_SIZE).join(", ");
        const more = names.length > CATEGORY_MENU_SAMPLE_SIZE ? ", …" : "";
        return `- ${category} (${names.length} procedures) — e.g. ${sample}${more}`;
      })
      .join("\n");
  }

  /**
   * Assemble a raw "procedures" LLM response back into `Procedure[]`. Grouped/
   * flat names are reunited with their category prefix (if any) and validated
   * against the catalogue's full canonical list — any assembled name not
   * found there is dropped (belt-and-braces; the grammar constraint should
   * already prevent this).
   */
  assemble(pick: unknown): Procedure[] {
    const canonical = this.canonicalList
      ? new Set(this.canonicalList)
      : undefined;
    const keep = (full: string) => !canonical || canonical.has(full);

    if (this.mode.kind === "freeform") {
      return (pick as Procedure[] | undefined) ?? [];
    }

    if (this.mode.kind === "flat") {
      return ((pick as ProcedureName[] | undefined) ?? [])
        .filter(keep)
        .map((name) => ({ name }));
    }

    const grouped = (pick as Record<string, ProcedureName[] | undefined>) ?? {};
    const result: Procedure[] = [];
    for (const [category, names] of Object.entries(grouped)) {
      if (!names) continue;
      for (const name of names) {
        const full =
          category === UNCATEGORIZED_CATEGORY ? name : `${category}: ${name}`;
        if (keep(full)) result.push({ name: full });
      }
    }
    return result;
  }
}
