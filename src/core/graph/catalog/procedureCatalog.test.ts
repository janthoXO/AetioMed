// InMemoryProcedureCatalog only — no filesystem, no SQLite, nothing imported
// from `03repo/`. See `src/core/graph/utils/prompt.test.ts` for the house
// style and the rationale for keeping tests off the `03repo/` modules.
import { describe, expect, it } from "vitest";

import { InMemoryProcedureCatalog } from "@/core/graph/catalog/procedureCatalog.js";

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

  it("scope() keeps the uncategorized bucket and returns a grouped set even when nothing matches", () => {
    const catalog = new InMemoryProcedureCatalog(["Lab: CRP", "Rest"]);

    const scoped = catalog.scope(["Imaging"]);
    expect(scoped.mode.kind).toBe("grouped");
    if (scoped.mode.kind === "grouped") {
      expect(scoped.mode.grouped.has("Imaging")).toBe(false);
      expect(scoped.mode.grouped.get("General")).toEqual(["Rest"]);
    }
  });

  it("exclude() drops a category that becomes empty", () => {
    const catalog = new InMemoryProcedureCatalog([
      "Lab: CRP",
      "Imaging: X-ray",
    ]);

    const excluded = catalog.candidates().exclude(["Lab: CRP"]);
    expect(excluded.categories()).toEqual(["Imaging"]);
  });

  it("categoryMenu(only) renders only the requested category", () => {
    const catalog = new InMemoryProcedureCatalog([
      "Lab: CRP",
      "Imaging: X-ray",
    ]);

    const menu = catalog.candidates().categoryMenu(["Imaging"]);
    expect(menu).toContain("Imaging");
    expect(menu).not.toContain("Lab");
  });
});
