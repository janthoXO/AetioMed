import { describe, expect, it, vi } from "vitest";
import { localizeHeadings } from "./headings.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import { InMemoryOutlineHeadingCatalog } from "@/adapters/catalog/outlineHeadings/index.js";
import { InMemoryAnamnesisCatalog } from "@/adapters/catalog/anamnesis/index.js";
import {
  parseTaggedOutline,
  type OutlineSegments,
} from "@/core/graph/shared/outline/segments.js";
import { taggedOutlineFixture } from "@/core/graph/shared/outline/fixtures.js";

function runtimeWith(opts: {
  categories?: string[];
  seed?: Record<string, Record<string, string>>;
  llm?: Record<string, string>;
}) {
  const structured = vi.fn<
    (call: unknown, prompt: { user: string }) => Promise<Record<string, string>>
  >(async () => opts.llm ?? {});
  const runtime = {
    llm: { structured, text: vi.fn() },
    catalogs: {
      outlineHeadings: new InMemoryOutlineHeadingCatalog(opts.seed),
      anamnesis: new InMemoryAnamnesisCatalog(opts.categories),
    },
    log: { info() {}, warn() {}, error() {} },
  } as unknown as GraphRuntime;
  return { runtime, structured };
}

const outline = (anamnesisCategories?: string[]): OutlineSegments =>
  parseTaggedOutline(taggedOutlineFixture({ anamnesisCategories }));

const CURATED = {
  German: {
    General: "Allgemein",
    Patient: "Patient",
    "Chief complaint": "Hauptbeschwerde",
    Anamnesis: "Anamnese",
    Procedures: "Untersuchungen",
  },
};

describe("localizeHeadings", () => {
  it("serves curated titles without an LLM call; editable segments are absent", async () => {
    const { runtime, structured } = runtimeWith({ seed: CURATED });

    const headings = await localizeHeadings(runtime, outline(), "German");

    expect([...headings.entries()]).toEqual([
      [1, "## Allgemein"],
      [3, "## Patient"],
      [5, "## Hauptbeschwerde"],
      [7, "## Anamnese"],
      [9, "## Untersuchungen"],
    ]);
    expect(structured).not.toHaveBeenCalled();
  });

  it("translates only the misses in one call, persists them to their own catalogue, and reuses them next time", async () => {
    const withoutProcedures: Record<string, string> = { ...CURATED.German };
    delete withoutProcedures["Procedures"];
    const { runtime, structured } = runtimeWith({
      categories: ["Medications"],
      seed: { German: withoutProcedures },
      llm: { Procedures: "Diagnostik", Medications: "Medikamente" },
    });
    const segments = outline(["Medications"]);

    const first = await localizeHeadings(runtime, segments, "German");
    const second = await localizeHeadings(runtime, segments, "German");

    expect(structured).toHaveBeenCalledTimes(1);
    expect(structured.mock.calls[0]![1].user).toContain("Procedures");
    expect(structured.mock.calls[0]![1].user).not.toContain("General");
    expect(first).toEqual(second);
    expect(first.get(9)).toBe("### Medikamente");
    expect(first.get(11)).toBe("## Diagnostik");
    expect(
      runtime.catalogs.outlineHeadings.fromEnglish("Medications", "German")
    ).toBeUndefined();
    expect(
      runtime.catalogs.anamnesis.fromEnglish("Medications", "German")
    ).toBe("Medikamente");
  });

  it("leaves LLM-named (freeform) category headings to the caller", async () => {
    const { runtime } = runtimeWith({ seed: CURATED });
    const segments = outline(["Whatever the model chose"]);

    const headings = await localizeHeadings(runtime, segments, "German");

    expect(headings.has(9)).toBe(false);
    expect(headings.size).toBe(5);
  });
});
