import z from "zod";
import { section } from "@/core/graph/shared/prompt/prompt.js";
import {
  ProcedureSchema,
  type Procedure,
} from "@/core/graph/shared/domain/Procedure.js";
import {
  filterTree,
  leafCount,
  leaves,
  refKey,
  type ProcedureRef,
} from "@/core/graph/shared/domain/ProcedureTree.js";
import type { ProcedureCandidates, ProcedureCatalogTree } from "./ports.js";

const LABEL_SEPARATOR = " > ";

/**
 * Shortest unique label per leaf, keyed by `refKey`: the bare name, prefixed
 * by parent categories (`X-ray > Thorax`) only while it collides. Built, never
 * parsed: a pick maps back through this table. Terminates: each round prefixes
 * at least one label or stops. Full paths are unique (sibling names are), so
 * only a name containing the separator could still collide.
 */
function shortestUniqueLabels(tree: ProcedureCatalogTree): Map<string, string> {
  const refs = leaves(tree).map(({ path, leaf }) => ({
    path,
    name: leaf.name,
  }));
  const depth = refs.map(() => 0);
  for (;;) {
    const labels = refs.map(({ path, name }, i) =>
      [...path.slice(path.length - depth[i]!), name].join(LABEL_SEPARATOR)
    );
    const count = new Map<string, number>();
    for (const label of labels) count.set(label, (count.get(label) ?? 0) + 1);
    let grew = false;
    refs.forEach((ref, i) => {
      if (count.get(labels[i]!)! > 1 && depth[i]! < ref.path.length) {
        depth[i]!++;
        grew = true;
      }
    });
    if (!grew) return new Map(refs.map((ref, i) => [refKey(ref), labels[i]!]));
  }
}

/**
 * Candidate procedures for one pick: a catalogue tree, or `undefined` for
 * freeform (no catalogue; the model invents names, refs come back at the root).
 * A pick is a flat, non-empty list of labels.
 */
export class ProcedureCandidatesImpl implements ProcedureCandidates {
  /** From the full catalogue, so labels stay stable across `exclude`. */
  private readonly labels: Map<string, string>;

  constructor(
    private readonly tree: ProcedureCatalogTree | undefined,
    labels?: Map<string, string>
  ) {
    this.labels = labels ?? (tree ? shortestUniqueLabels(tree) : new Map());
  }

  /**
   * Already-ordered procedures leave the set, so a duplicate order is
   * impossible by construction; emptied categories disappear. Freeform passes
   * through (a prompt rule covers it).
   */
  exclude(ordered: ProcedureRef[]): ProcedureCandidates {
    if (!this.tree) return this;
    const orderedKeys = new Set(ordered.map(refKey));
    return new ProcedureCandidatesImpl(
      filterTree(
        this.tree,
        (path, leaf) => !orderedKeys.has(refKey({ path, name: leaf.name }))
      ),
      this.labels
    );
  }

  isEmpty(): boolean {
    return this.tree !== undefined && leafCount(this.tree) === 0;
  }

  /** Remaining leaves by label. */
  private byLabel(): Map<string, ProcedureRef> {
    return new Map(
      leaves(this.tree ?? { categories: [], procedures: [] }).map(
        ({ path, leaf }) => {
          const ref = { path, name: leaf.name };
          return [this.labels.get(refKey(ref))!, ref];
        }
      )
    );
  }

  /**
   * Pick grammar, passed to `withStructuredOutput`: at least one label.
   *
   * ponytail: one enum over every remaining label; providers that enforce
   * schemas cap enum size (OpenAI strict ~1000 values), so a far larger
   * catalogue needs narrowing before the pick.
   */
  grammar(): z.ZodTypeAny {
    if (!this.tree) {
      return z
        .array(ProcedureSchema)
        .min(1)
        .describe("one or more mutually independent procedures to order now");
    }
    // Names the bad value: the default lists every label and gets truncated
    // in the retry feedback, so the model never learns what it got wrong.
    const label = z.literal([...this.byLabel().keys()], {
      error: (issue) =>
        `${JSON.stringify(issue.input)} is not a procedure label; category headings cannot be ordered, use the exact labels listed after "- "`,
    });
    return z
      .array(label)
      .min(1)
      .describe("one or more exact procedure labels from the catalogue");
  }

  /** Label-agnostic counterpart of {@link grammar} for the prompt's "Output format"; keeps the prompt short and stable. */
  promptSchema(): z.ZodTypeAny {
    if (!this.tree) return this.grammar();
    return z
      .array(z.string())
      .min(1)
      .describe("one or more exact procedure labels from the catalogue");
  }

  render(): string | undefined {
    if (!this.tree) return undefined;
    return section(
      "Approved procedure catalogue (RESTRICTED WORKUP)",
      `You MUST ONLY select procedures from this catalogue, by their exact label as listed after "- ". Category headings give context and cannot be ordered. Do not invent or recommend any procedures not listed:
${renderTree(this.tree, this.labels)}`
    );
  }

  assemble(pick: unknown): ProcedureRef[] {
    if (!this.tree) {
      return ((pick as Procedure[] | undefined) ?? []).map((p) => ({
        path: [],
        name: p.name,
      }));
    }
    const byLabel = this.byLabel();
    // A repeated label is one order; an unknown one is dropped.
    return [...new Set((pick as string[] | undefined) ?? [])].flatMap(
      (label) => {
        const ref = byLabel.get(label);
        return ref ? [ref] : [];
      }
    );
  }
}

/** Indented outline: categories as `name:`, their procedures as `- label` below. */
function renderTree(
  tree: ProcedureCatalogTree,
  labels: Map<string, string>,
  path: string[] = []
): string {
  const indent = "  ".repeat(path.length);
  return [
    ...tree.procedures.map(
      (p) => `${indent}- ${labels.get(refKey({ path, name: p.name }))}`
    ),
    ...tree.categories.map(
      (c) => `${indent}${c.name}:\n${renderTree(c, labels, [...path, c.name])}`
    ),
  ].join("\n");
}
