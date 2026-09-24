import z from "zod";
import { section } from "../../utils/prompt.js";
import { ProcedureSchema, type Procedure } from "../../models/Procedure.js";
import {
  filterTree,
  leafCount,
  leaves,
  refKey,
  type ProcedureRef,
} from "../../models/ProcedureTree.js";
import type {
  LevelItem,
  ProcedureCandidates,
  ProcedureCatalogTree,
} from "../ports.js";

const LEVEL_SAMPLE_SIZE = 3;

/**
 * Candidate procedures for one pick: a catalogue tree, or `undefined` for
 * freeform (no catalogue; the model invents names, refs come back at the root).
 */
export class ProcedureCandidatesImpl implements ProcedureCandidates {
  constructor(private readonly tree: ProcedureCatalogTree | undefined) {}

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
      )
    );
  }

  size(): number | undefined {
    return this.tree && leafCount(this.tree);
  }

  levelItems(open: string[][]): LevelItem[] {
    if (!this.tree) return [];
    const tree = this.tree;
    return open.flatMap((path) => {
      const node = subtreeAt(tree, path);
      if (!node) return [];
      return [
        ...node.categories.map(
          (c): LevelItem => ({
            kind: "category",
            path: [...path, c.name],
            size: leafCount(c),
            sample: leaves(c)
              .slice(0, LEVEL_SAMPLE_SIZE)
              .map((l) => l.leaf.name),
          })
        ),
        ...node.procedures.map(
          (p): LevelItem => ({ kind: "procedure", ref: { path, name: p.name } })
        ),
      ];
    });
  }

  narrow(
    procedures: ProcedureRef[],
    categories: string[][]
  ): ProcedureCandidates {
    if (!this.tree) return this;
    const keys = new Set(procedures.map(refKey));
    const under = (path: string[]) =>
      categories.some(
        (category) =>
          path.length >= category.length &&
          category.every((name, i) => path[i] === name)
      );
    return new ProcedureCandidatesImpl(
      filterTree(
        this.tree,
        (path, leaf) =>
          under(path) || keys.has(refKey({ path, name: leaf.name }))
      )
    );
  }

  isEmpty(): boolean {
    return this.tree !== undefined && leafCount(this.tree) === 0;
  }

  /** Pick grammar, passed to `withStructuredOutput`. Mirrors the tree: categories keyed by exact name. */
  grammar(): z.ZodTypeAny {
    if (!this.tree) {
      return z
        .array(ProcedureSchema)
        .describe("one or more mutually independent procedures to order now");
    }
    return treePickGrammar(this.tree).describe(
      "procedures to order now, placed under their exact categories"
    );
  }

  /** Name-agnostic counterpart of {@link grammar} for the prompt's "Output format"; keeps the prompt short and stable. */
  promptSchema(): z.ZodTypeAny {
    if (!this.tree) {
      return z
        .array(ProcedureSchema)
        .describe("one or more mutually independent procedures to order now");
    }
    return z
      .object({
        procedures: z
          .array(z.string())
          .optional()
          .describe("exact names of procedures at this level"),
        categories: z
          .record(
            z.string(),
            z.object({}).describe("same shape as this object, one level down")
          )
          .optional()
          .describe("sub-selections keyed by exact category name"),
      })
      .describe("procedures to order now, placed under their exact categories");
  }

  render(): string | undefined {
    if (!this.tree) return undefined;
    return section(
      "Approved procedure catalogue (RESTRICTED WORKUP)",
      `You MUST ONLY select procedures from this catalogue, using their exact names, placed under their exact category names (nest sub-categories the same way). Do not invent or recommend any procedures not listed:
${renderTree(this.tree)}`
    );
  }

  assemble(pick: unknown): ProcedureRef[] {
    if (!this.tree) {
      return ((pick as Procedure[] | undefined) ?? []).map((p) => ({
        path: [],
        name: p.name,
      }));
    }
    const refs: ProcedureRef[] = [];
    assembleTree(this.tree, pick, [], refs);
    // A repeated name in the model's array is one order.
    const seen = new Set<string>();
    return refs.filter((ref) => {
      const key = refKey(ref);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

function treePickGrammar(tree: ProcedureCatalogTree): z.ZodObject {
  const shape: Record<string, z.ZodTypeAny> = {};
  if (tree.procedures.length > 0) {
    shape.procedures = z
      .array(z.literal(tree.procedures.map((p) => p.name)))
      .optional()
      .describe("exact names of procedures at this level");
  }
  if (tree.categories.length > 0) {
    shape.categories = z
      .object(
        Object.fromEntries(
          tree.categories.map((c) => [c.name, treePickGrammar(c).optional()])
        )
      )
      .optional()
      .describe("sub-selections keyed by exact category name");
  }
  return z.object(shape);
}

function subtreeAt(
  tree: ProcedureCatalogTree,
  path: string[]
): ProcedureCatalogTree | undefined {
  let node: ProcedureCatalogTree | undefined = tree;
  for (const name of path) {
    node = node?.categories.find((c) => c.name === name);
  }
  return node;
}

/** Indented outline: procedures as `- name`, categories as `name:` with their contents below. */
function renderTree(tree: ProcedureCatalogTree, indent = ""): string {
  return [
    ...tree.procedures.map((p) => `${indent}- ${p.name}`),
    ...tree.categories.map(
      (c) => `${indent}${c.name}:\n${renderTree(c, `${indent}  `)}`
    ),
  ].join("\n");
}

type TreePick = {
  procedures?: string[];
  categories?: Record<string, TreePick | undefined>;
};

/** Walks the pick alongside the tree; names not in the tree are dropped. */
function assembleTree(
  tree: ProcedureCatalogTree,
  pick: unknown,
  path: string[],
  out: ProcedureRef[]
) {
  if (!pick || typeof pick !== "object") return;
  const { procedures, categories } = pick as TreePick;
  const names = new Set(tree.procedures.map((p) => p.name));
  for (const name of procedures ?? []) {
    if (names.has(name)) out.push({ path, name });
  }
  for (const category of tree.categories) {
    assembleTree(
      category,
      categories?.[category.name],
      [...path, category.name],
      out
    );
  }
}
