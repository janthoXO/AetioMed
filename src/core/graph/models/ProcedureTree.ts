import z from "zod";

/**
 * Procedures grouped under categories of any depth. Uniform at every level: the
 * root has the same shape as a category, minus the name. Catalogue, picks and
 * `Case.procedures` are all this shape with different leaves.
 */
export type ProcedureTree<P> = {
  categories: ProcedureCategory<P>[];
  procedures: P[];
};
export type ProcedureCategory<P> = { name: string } & ProcedureTree<P>;

/** Recursive schema for a {@link ProcedureTree} whose leaves match `leaf`. */
export function procedureTreeSchema<L extends z.ZodType>(
  leaf: L
): z.ZodType<ProcedureTree<z.output<L>>, ProcedureTreeInput<z.input<L>>> {
  const category: z.ZodType = z.object({
    name: z.string().min(1),
    get categories() {
      return z.array(category).default([]);
    },
    procedures: z.array(leaf).default([]),
  });
  return z.object({
    categories: z.array(category).default([]),
    procedures: z.array(leaf).default([]),
  }) as never;
}
type ProcedureTreeInput<P> = {
  categories?: ({ name: string } & ProcedureTreeInput<P>)[] | undefined;
  procedures?: P[] | undefined;
};

/** A procedure's position: category names from the root, then its own name. */
export const ProcedureRefSchema = z.object({
  path: z.array(z.string()).describe("Category names from the root"),
  name: z.string().describe("Name of the medical procedure"),
});
export type ProcedureRef = z.infer<typeof ProcedureRefSchema>;

/** Identity string for a node (category or procedure) at `path`. Built, never parsed. */
export function nodeKey(path: string[]): string {
  return JSON.stringify(path);
}

export function refKey(ref: ProcedureRef): string {
  return nodeKey([...ref.path, ref.name]);
}

/** Human/LLM-facing label, e.g. `Cardiology › Resting ECG`. */
export function refLabel(ref: ProcedureRef): string {
  return [...ref.path, ref.name].join(" › ");
}

export function emptyTree<P>(): ProcedureTree<P> {
  return { categories: [], procedures: [] };
}

/** Every leaf with its category path, own procedures before sub-categories, depth first. */
export function leaves<P>(
  tree: ProcedureTree<P>,
  path: string[] = []
): { path: string[]; leaf: P }[] {
  return [
    ...tree.procedures.map((leaf) => ({ path, leaf })),
    ...tree.categories.flatMap((c) => leaves(c, [...path, c.name])),
  ];
}

export function leafCount(tree: ProcedureTree<unknown>): number {
  return (
    tree.procedures.length +
    tree.categories.reduce((n, c) => n + leafCount(c), 0)
  );
}

/** Keeps leaves passing `keep`; categories left without leaves are dropped. */
export function filterTree<P>(
  tree: ProcedureTree<P>,
  keep: (path: string[], leaf: P) => boolean,
  path: string[] = []
): ProcedureTree<P> {
  return {
    procedures: tree.procedures.filter((leaf) => keep(path, leaf)),
    categories: tree.categories
      .map((c) => ({
        name: c.name,
        ...filterTree(c, keep, [...path, c.name]),
      }))
      .filter((c) => leafCount(c) > 0),
  };
}

/** Same structure, leaves mapped and category names optionally renamed. */
export function mapTree<P, Q>(
  tree: ProcedureTree<P>,
  fns: {
    leaf: (path: string[], leaf: P) => Q;
    category?: (path: string[], name: string) => string;
  },
  path: string[] = []
): ProcedureTree<Q> {
  return {
    procedures: tree.procedures.map((leaf) => fns.leaf(path, leaf)),
    categories: tree.categories.map((c) => {
      const childPath = [...path, c.name];
      return {
        name: fns.category ? fns.category(childPath, c.name) : c.name,
        ...mapTree(c, fns, childPath),
      };
    }),
  };
}

/** Builds a tree from path-tagged leaves; categories in first-seen order. */
export function buildTree<P>(
  entries: { path: string[]; leaf: P }[]
): ProcedureTree<P> {
  const root = emptyTree<P>();
  for (const { path, leaf } of entries) {
    let node: ProcedureTree<P> = root;
    for (const name of path) {
      let child = node.categories.find((c) => c.name === name);
      if (!child) {
        child = { name, ...emptyTree<P>() };
        node.categories.push(child);
      }
      node = child;
    }
    node.procedures.push(leaf);
  }
  return root;
}

/** Every node's path — categories and procedures — for key-space checks. */
export function nodePaths(
  tree: ProcedureTree<{ name: string }>,
  path: string[] = []
): string[][] {
  return [
    ...tree.procedures.map((p) => [...path, p.name]),
    ...tree.categories.flatMap((c) => [
      [...path, c.name],
      ...nodePaths(c, [...path, c.name]),
    ]),
  ];
}

/** Paths of names that repeat among siblings (categories and procedures share one level). */
export function duplicateSiblings(
  tree: ProcedureTree<{ name: string }>,
  path: string[] = []
): string[][] {
  const names = [
    ...tree.categories.map((c) => c.name),
    ...tree.procedures.map((p) => p.name),
  ];
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  return [
    ...[...new Set(dupes)].map((n) => [...path, n]),
    ...tree.categories.flatMap((c) => duplicateSiblings(c, [...path, c.name])),
  ];
}
