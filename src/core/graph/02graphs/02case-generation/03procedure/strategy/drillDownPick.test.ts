// `drillDown` against a real candidate tree and a scripted `select`: which levels are shown, what is kept, when it stops.
import { describe, expect, it, vi } from "vitest";
import { ProcedureCandidatesImpl } from "@/core/graph/catalog/procedures/candidates.js";
import type { LevelItem } from "@/core/graph/catalog/ports.js";
import type { LevelSelection } from "@/core/graph/03aigateway/procedures.aigateway.js";
import type { ProcedureTree } from "@/core/graph/models/ProcedureTree.js";
import { drillDown, MAX_PICK_CANDIDATES } from "./drillDownPick.js";

function procs(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}` }));
}

// 1 + 300 + 50 + 100 = 451 procedures: over the threshold at the root.
const catalogue: ProcedureTree<{ name: string }> = {
  procedures: [{ name: "Vitals" }],
  categories: [
    {
      name: "Lab",
      procedures: [],
      categories: [
        { name: "Chemistry", procedures: procs("chem", 300), categories: [] },
        { name: "Serology", procedures: procs("sero", 50), categories: [] },
      ],
    },
    { name: "Imaging", procedures: procs("img", 100), categories: [] },
  ],
};

const candidates = new ProcedureCandidatesImpl(catalogue);

function keep(...labels: string[]) {
  return (items: LevelItem[]): LevelSelection => ({
    action: "select",
    items: items.filter((item) =>
      labels.includes(
        item.kind === "category"
          ? item.path.join("/")
          : [...item.ref.path, item.ref.name].join("/")
      )
    ),
  });
}

describe("drillDown", () => {
  it("opens kept categories one level deeper until the pool is under the threshold, keeping chosen procedures", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(keep("Lab", "Vitals")) // 351 left: open Lab
      .mockImplementationOnce(keep("Lab/Serology")); // Vitals + 50

    const result = await drillDown(candidates, select);

    expect(select).toHaveBeenCalledTimes(2);
    expect(select.mock.calls.map(([, first]) => first)).toEqual([true, false]);
    const secondLevel = (select.mock.calls[1]![0] as LevelItem[]).map((item) =>
      item.kind === "category" ? item.path.join("/") : item.ref.name
    );
    expect(secondLevel).toEqual(["Lab/Chemistry", "Lab/Serology"]);
    expect("candidates" in result && result.candidates.size()).toBe(51);
  });

  it("stops at the first level when the kept pool is already small enough", async () => {
    const select = vi.fn().mockImplementationOnce(keep("Imaging"));
    const result = await drillDown(candidates, select);
    expect(select).toHaveBeenCalledTimes(1);
    expect("candidates" in result && result.candidates.size()).toBe(100);
    expect(100).toBeLessThan(MAX_PICK_CANDIDATES);
  });

  it("descends into a category of only procedures, where selecting single procedures ends the loop", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(keep("Lab")) // 350: open Lab
      .mockImplementationOnce(keep("Lab/Chemistry")) // 300: open Chemistry
      .mockImplementationOnce(
        keep("Lab/Chemistry/chem1", "Lab/Chemistry/chem7")
      );
    const result = await drillDown(candidates, select);
    expect(select).toHaveBeenCalledTimes(3);
    expect((select.mock.calls[2]![0] as LevelItem[]).length).toBe(300);
    expect("candidates" in result && result.candidates.size()).toBe(2);
  });

  it("returns a diagnosis from the first level without narrowing further", async () => {
    const select = vi.fn().mockResolvedValueOnce({
      action: "diagnose",
      diagnosisName: "Influenza",
    } satisfies LevelSelection);
    expect(await drillDown(candidates, select)).toEqual({
      diagnosed: { action: "diagnose", diagnosisName: "Influenza" },
    });
  });

  it("an empty selection leaves nothing to pick", async () => {
    const result = await drillDown(candidates, keep());
    expect("candidates" in result && result.candidates.isEmpty()).toBe(true);
  });
});

describe("ProcedureCandidates.levelItems / narrow", () => {
  it("lists a level's categories with size and sample, then its procedures", () => {
    const [lab, imaging, vitals] = candidates.levelItems([[]]);
    expect(lab).toEqual({
      kind: "category",
      path: ["Lab"],
      size: 350,
      sample: ["chem0", "chem1", "chem2"],
    });
    expect(imaging).toMatchObject({ kind: "category", path: ["Imaging"] });
    expect(vitals).toEqual({
      kind: "procedure",
      ref: { path: [], name: "Vitals" },
    });
  });

  it("narrows to named procedures plus whole categories, at any depth", () => {
    const narrowed = candidates.narrow(
      [{ path: ["Imaging"], name: "img3" }],
      [["Lab", "Serology"]]
    );
    expect(narrowed.size()).toBe(51);
  });
});
