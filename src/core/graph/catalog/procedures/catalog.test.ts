// InMemoryProcedureCatalog only: no filesystem, SQLite or repo imports.
import { describe, expect, it } from "vitest";

import { InMemoryProcedureCatalog } from "@/core/graph/catalog/procedures/catalog.js";

describe("InMemoryProcedureCatalog candidates()", () => {
  it("exclude().grammar() rejects an excluded name and accepts a remaining one", () => {
    const catalog = new InMemoryProcedureCatalog([
      "Lab: CRP",
      "Lab: WBC",
      "Imaging: Chest X-ray",
    ]);

    const grammar = catalog.candidates().exclude(["Lab: CRP"]).grammar();

    expect(grammar.safeParse({ Lab: ["CRP"] }).success).toBe(false);
    expect(grammar.safeParse({ Lab: ["WBC"] }).success).toBe(true);
  });

  it("a flat catalogue yields no categories and a flat mode", () => {
    const catalog = new InMemoryProcedureCatalog(["CRP", "WBC", "Chest X-ray"]);

    expect(catalog.categories()).toEqual([]);
    expect(catalog.candidates().mode.kind).toBe("flat");
  });

  it("an undefined catalogue yields freeform mode", () => {
    const catalog = new InMemoryProcedureCatalog(undefined);
    const candidates = catalog.candidates();

    expect(candidates.mode.kind).toBe("freeform");
    expect(candidates.render()).toBeUndefined();
    expect(candidates.isEmpty()).toBe(false);
  });

  it("assemble() reunites grouped picks, passes through uncategorized names, and drops unknown names", () => {
    const catalog = new InMemoryProcedureCatalog([
      "Lab: CRP",
      "Lab: WBC",
      "Rest",
    ]);
    const candidates = catalog.candidates();

    expect(
      candidates.assemble({ Lab: ["CRP"], General: ["Rest"], Bogus: ["X"] })
    ).toEqual([{ name: "Lab: CRP" }, { name: "Rest" }]);
  });
});
