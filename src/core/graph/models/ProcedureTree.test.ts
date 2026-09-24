// Tree helpers and the tree-shaped pick grammar: the shapes every procedure consumer relies on.
import { describe, expect, it } from "vitest";
import z from "zod";
import {
  buildTree,
  duplicateSiblings,
  filterTree,
  leafCount,
  leaves,
  mapTree,
  nodeKey,
  nodePaths,
  procedureTreeSchema,
  refKey,
  refLabel,
  type ProcedureTree,
} from "./ProcedureTree.js";
import { ProcedureCandidatesImpl } from "../catalog/procedures/candidates.js";

const catalogue: ProcedureTree<{ name: string }> = {
  procedures: [{ name: "Blood pressure" }],
  categories: [
    {
      name: "Cardiology",
      procedures: [{ name: "Resting ECG" }],
      categories: [
        {
          name: "Echo",
          procedures: [{ name: "Transthoracic" }, { name: "Transesophageal" }],
          categories: [],
        },
      ],
    },
  ],
};

describe("procedure tree helpers", () => {
  it("parses a YAML-style tree with missing lists defaulted", () => {
    const schema = procedureTreeSchema(z.object({ name: z.string() }));
    expect(
      schema.parse({ categories: [{ name: "A", procedures: [{ name: "x" }] }] })
    ).toEqual({
      procedures: [],
      categories: [{ name: "A", procedures: [{ name: "x" }], categories: [] }],
    });
  });

  it("lists leaves with their category path, own procedures first", () => {
    expect(leaves(catalogue).map((l) => [...l.path, l.leaf.name])).toEqual([
      ["Blood pressure"],
      ["Cardiology", "Resting ECG"],
      ["Cardiology", "Echo", "Transthoracic"],
      ["Cardiology", "Echo", "Transesophageal"],
    ]);
    expect(leafCount(catalogue)).toBe(4);
  });

  it("filters leaves and drops categories left empty", () => {
    const kept = filterTree(catalogue, (path) => path.length < 2);
    expect(leafCount(kept)).toBe(2);
    expect(kept.categories[0]!.categories).toEqual([]);
  });

  it("round-trips leaves through buildTree, merging repeated categories in first-seen order", () => {
    const rebuilt = buildTree(leaves(catalogue));
    expect(rebuilt).toEqual(catalogue);
  });

  it("maps leaves and renames categories by their full path", () => {
    const mapped = mapTree(catalogue, {
      category: (path, name) =>
        nodeKey(path) === nodeKey(["Cardiology"]) ? "Kardiologie" : name,
      leaf: (_path, leaf) => ({ name: leaf.name.toUpperCase() }),
    });
    expect(mapped.categories[0]!.name).toBe("Kardiologie");
    expect(mapped.categories[0]!.categories[0]!.procedures[0]!.name).toBe(
      "TRANSTHORACIC"
    );
  });

  it("names every node path and finds duplicate siblings across categories and procedures", () => {
    expect(nodePaths(catalogue)).toContainEqual(["Cardiology", "Echo"]);
    expect(
      duplicateSiblings({
        procedures: [{ name: "Echo" }],
        categories: [
          { name: "Echo", procedures: [{ name: "x" }], categories: [] },
        ],
      })
    ).toEqual([["Echo"]]);
    expect(duplicateSiblings(catalogue)).toEqual([]);
  });

  it("keys and labels a ref by its full path", () => {
    const ref = { path: ["Cardiology", "Echo"], name: "Transthoracic" };
    expect(refKey(ref)).toBe(nodeKey(["Cardiology", "Echo", "Transthoracic"]));
    expect(refLabel(ref)).toBe("Cardiology › Echo › Transthoracic");
  });
});

describe("ProcedureCandidatesImpl over a tree", () => {
  const candidates = new ProcedureCandidatesImpl(catalogue);

  it("accepts a nested pick and assembles it to refs, dropping unknown names and repeats", () => {
    const pick = {
      procedures: ["Blood pressure"],
      categories: {
        Cardiology: {
          categories: {
            Echo: { procedures: ["Transthoracic", "Transthoracic"] },
          },
        },
      },
    };
    expect(candidates.grammar().safeParse(pick).success).toBe(true);
    expect(candidates.assemble(pick)).toEqual([
      { path: [], name: "Blood pressure" },
      { path: ["Cardiology", "Echo"], name: "Transthoracic" },
    ]);
    expect(
      candidates.assemble({
        categories: { Cardiology: { procedures: ["Invented"] } },
      })
    ).toEqual([]);
  });

  it("rejects a name placed under the wrong category", () => {
    expect(
      candidates.grammar().safeParse({
        categories: { Cardiology: { procedures: ["Blood pressure"] } },
      }).success
    ).toBe(false);
  });

  it("excludes ordered refs and becomes empty once everything is ordered", () => {
    const rest = candidates.exclude([
      { path: ["Cardiology"], name: "Resting ECG" },
    ]);
    expect(
      rest.assemble({
        categories: { Cardiology: { procedures: ["Resting ECG"] } },
      })
    ).toEqual([]);
    expect(
      candidates
        .exclude(
          leaves(catalogue).map((l) => ({ path: l.path, name: l.leaf.name }))
        )
        .isEmpty()
    ).toBe(true);
  });

  it("freeform: invented names come back at the root", () => {
    const freeform = new ProcedureCandidatesImpl(undefined);
    expect(freeform.render()).toBeUndefined();
    expect(freeform.assemble([{ name: "Anything" }])).toEqual([
      { path: [], name: "Anything" },
    ]);
  });
});
