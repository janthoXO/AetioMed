import { describe, expect, it } from "vitest";
import {
  checkSkeleton,
  freezeGeneral,
  isCanonicalShape,
  joinOutline,
  OutlineFormatError,
  outlineSkeleton,
  OUTLINE_SECTIONS,
  parseTaggedOutline,
  outlineSections,
  renderTaggedOutline,
  restoreSkeletonHeadings,
  tagBareHeadings,
  type OutlineSegments,
} from "./segments.js";

describe("parseTaggedOutline", () => {
  it("splits a simple outline into the canonical alternating shape", () => {
    const markdown = "<fixed>## General</fixed>\n\nSome intro text.";
    const segments = parseTaggedOutline(markdown);
    expect(segments).toEqual([
      { fixed: false, text: "" },
      { fixed: true, text: "## General" },
      { fixed: false, text: "Some intro text." },
    ]);
  });

  it("keeps leading and trailing editable text", () => {
    const markdown = "leading\n\n<fixed>## General</fixed>\n\ntrailing";
    const segments = parseTaggedOutline(markdown);
    expect(segments).toEqual([
      { fixed: false, text: "leading" },
      { fixed: true, text: "## General" },
      { fixed: false, text: "trailing" },
    ]);
  });

  it("inserts an empty editable segment between adjacent fixed blocks", () => {
    const markdown = "<fixed>## General</fixed><fixed>## Patient</fixed>";
    const segments = parseTaggedOutline(markdown);
    expect(segments).toEqual([
      { fixed: false, text: "" },
      { fixed: true, text: "## General" },
      { fixed: false, text: "" },
      { fixed: true, text: "## Patient" },
      { fixed: false, text: "" },
    ]);
  });

  it("trims fixed and editable text", () => {
    const markdown = "  intro  \n\n<fixed>  ## General  </fixed>\n\n  outro  ";
    const segments = parseTaggedOutline(markdown);
    expect(segments).toEqual([
      { fixed: false, text: "intro" },
      { fixed: true, text: "## General" },
      { fixed: false, text: "outro" },
    ]);
  });

  it("throws OutlineFormatError on nested <fixed>", () => {
    expect(() =>
      parseTaggedOutline("<fixed>## General<fixed>oops</fixed></fixed>")
    ).toThrow(OutlineFormatError);
  });

  it("throws OutlineFormatError on unclosed <fixed>", () => {
    expect(() => parseTaggedOutline("<fixed>## General")).toThrow(
      OutlineFormatError
    );
  });

  it("throws OutlineFormatError on a stray </fixed>", () => {
    expect(() => parseTaggedOutline("text</fixed>more")).toThrow(
      OutlineFormatError
    );
  });

  it("throws OutlineFormatError on an empty fixed block", () => {
    expect(() => parseTaggedOutline("<fixed></fixed>")).toThrow(
      OutlineFormatError
    );
    expect(() => parseTaggedOutline("<fixed>   </fixed>")).toThrow(
      OutlineFormatError
    );
  });
});

describe("renderTaggedOutline", () => {
  it("round-trips through parseTaggedOutline for canonical, trimmed segments", () => {
    const segments: OutlineSegments = [
      { fixed: false, text: "" },
      { fixed: true, text: "## General" },
      { fixed: false, text: "" },
      { fixed: true, text: "## Patient" },
      { fixed: false, text: "Some patient text" },
    ];
    const rendered = renderTaggedOutline(segments);
    expect(parseTaggedOutline(rendered)).toEqual(segments);
  });

  it("omits empty editable segments from the rendered text", () => {
    const segments: OutlineSegments = [
      { fixed: false, text: "" },
      { fixed: true, text: "## General" },
      { fixed: false, text: "" },
    ];
    const rendered = renderTaggedOutline(segments);
    expect(rendered).toBe("<fixed>## General</fixed>");
  });
});

describe("joinOutline", () => {
  it("joins fixed and non-empty editable text with blank lines", () => {
    const segments: OutlineSegments = [
      { fixed: false, text: "" },
      { fixed: true, text: "## General" },
      { fixed: false, text: "Some prose." },
    ];
    expect(joinOutline(segments)).toBe("## General\n\nSome prose.");
  });

  it("escapes <fixed>/</fixed> occurrences inside editable text", () => {
    const segments: OutlineSegments = [
      { fixed: false, text: "Reviewer typed <fixed>literally</fixed> here." },
    ];
    expect(joinOutline(segments)).toBe(
      "Reviewer typed &lt;fixed&gt;literally&lt;/fixed&gt; here."
    );
  });

  it("never escapes text inside a fixed segment", () => {
    const segments: OutlineSegments = [
      { fixed: true, text: "## Heading with <fixed> in it" },
    ];
    expect(joinOutline(segments)).toBe("## Heading with <fixed> in it");
  });
});

describe("outlineSkeleton / OUTLINE_SECTIONS", () => {
  it("exposes the five fixed section titles, keyed, in outline order", () => {
    expect(Object.entries(OUTLINE_SECTIONS)).toEqual([
      ["general", "General"],
      ["patient", "Patient"],
      ["chiefComplaint", "Chief complaint"],
      ["anamnesis", "Anamnesis"],
      ["procedures", "Procedures"],
    ]);
  });

  it("builds a skeleton without category headings when none are given", () => {
    expect(outlineSkeleton({})).toEqual([
      "## General",
      "## Patient",
      "## Chief complaint",
      "## Anamnesis",
      "## Procedures",
    ]);
  });

  it("builds a skeleton with one ### heading per anamnesis category", () => {
    expect(
      outlineSkeleton({ anamnesisCategories: ["Pain", "History"] })
    ).toEqual([
      "## General",
      "## Patient",
      "## Chief complaint",
      "## Anamnesis",
      "### Pain",
      "### History",
      "## Procedures",
    ]);
  });

  it("treats an empty category array like no categories", () => {
    expect(outlineSkeleton({ anamnesisCategories: [] })).toEqual(
      outlineSkeleton({})
    );
  });
});

function skeletonSegments(categories: string[]): OutlineSegments {
  const fixedTexts = outlineSkeleton({ anamnesisCategories: categories });
  const segments: OutlineSegments = [{ fixed: false, text: "" }];
  for (const text of fixedTexts) {
    segments.push({ fixed: true, text });
    segments.push({ fixed: false, text: "" });
  }
  return segments;
}

describe("tagBareHeadings", () => {
  it("tags bare expected headings so the skeleton check passes", () => {
    const anamnesisCategories = ["Medications", "Allergies"];
    const skeleton = outlineSkeleton({ anamnesisCategories });
    const llmOutput = skeleton
      .map((h) =>
        h.startsWith("### ") ? `${h}\nfacts` : `<fixed>${h}</fixed>\nfacts`
      )
      .join("\n");

    expect(
      checkSkeleton(parseTaggedOutline(llmOutput), { anamnesisCategories }).ok
    ).toBe(false);
    const segments = parseTaggedOutline(tagBareHeadings(llmOutput, skeleton));
    expect(checkSkeleton(segments, { anamnesisCategories })).toEqual({
      ok: true,
    });
  });

  it("leaves tagged headings and other lines alone", () => {
    const text = "<fixed>## General</fixed>\n## General notes\n  ## Patient  ";
    expect(tagBareHeadings(text, ["## General", "## Patient"])).toBe(
      "<fixed>## General</fixed>\n## General notes\n<fixed>## Patient</fixed>"
    );
  });
});

describe("checkSkeleton", () => {
  it("accepts an exact skeleton match with configured categories", () => {
    const segments = skeletonSegments(["Pain"]);
    expect(checkSkeleton(segments, { anamnesisCategories: ["Pain"] })).toEqual({
      ok: true,
    });
  });

  it("rejects a mismatched heading, naming the index", () => {
    const segments = skeletonSegments(["Pain"]);
    segments[1] = { fixed: true, text: "## Wrong" };
    const result = checkSkeleton(segments, { anamnesisCategories: ["Pain"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("index 0");
    }
  });

  it("accepts a freeform outline with LLM-chosen categories when catalogue is undefined", () => {
    const segments = skeletonSegments(["Whatever", "The LLM Wants"]);
    expect(checkSkeleton(segments, { anamnesisCategories: undefined })).toEqual(
      { ok: true }
    );
  });

  it("accepts a freeform outline with zero categories", () => {
    const segments = skeletonSegments([]);
    expect(checkSkeleton(segments, { anamnesisCategories: undefined })).toEqual(
      { ok: true }
    );
  });

  it("rejects a freeform category heading missing the ### prefix", () => {
    const segments = skeletonSegments(["Pain"]);
    // Replace "### Pain" with a bad heading.
    const painIndex = segments.findIndex((s) => s.text === "### Pain");
    segments[painIndex] = { fixed: true, text: "## Pain" };
    const result = checkSkeleton(segments, { anamnesisCategories: undefined });
    expect(result.ok).toBe(false);
  });

  it("rejects a freeform category heading with an empty name", () => {
    const segments = skeletonSegments(["Pain"]);
    const painIndex = segments.findIndex((s) => s.text === "### Pain");
    segments[painIndex] = { fixed: true, text: "###" };
    const result = checkSkeleton(segments, { anamnesisCategories: undefined });
    expect(result.ok).toBe(false);
  });

  it("rejects a freeform outline missing the trailing Procedures heading", () => {
    const segments = skeletonSegments([]).slice(0, -2);
    const result = checkSkeleton(segments, { anamnesisCategories: undefined });
    expect(result.ok).toBe(false);
  });
});

describe("isCanonicalShape", () => {
  it("accepts an odd-length array alternating editable/fixed, starting and ending editable", () => {
    expect(
      isCanonicalShape([
        { fixed: false, text: "" },
        { fixed: true, text: "## General" },
        { fixed: false, text: "body" },
      ])
    ).toBe(true);
  });

  it("rejects an even length", () => {
    expect(
      isCanonicalShape([
        { fixed: false, text: "" },
        { fixed: true, text: "## General" },
      ])
    ).toBe(false);
  });

  it("rejects two fixed segments in a row", () => {
    expect(
      isCanonicalShape([
        { fixed: true, text: "## General" },
        { fixed: true, text: "## Patient" },
        { fixed: false, text: "" },
      ])
    ).toBe(false);
  });

  it("rejects a single fixed segment (must start editable)", () => {
    expect(isCanonicalShape([{ fixed: true, text: "## General" }])).toBe(false);
  });

  it("accepts a single editable segment", () => {
    expect(isCanonicalShape([{ fixed: false, text: "anything" }])).toBe(true);
  });
});

describe("restoreSkeletonHeadings", () => {
  const categories = ["History", "Medication"];

  function catalogueOutline(headings: string[]): OutlineSegments {
    const segments: OutlineSegments = [{ fixed: false, text: "" }];
    for (const heading of headings) {
      segments.push({ fixed: true, text: heading });
      segments.push({ fixed: false, text: "body" });
    }
    return segments;
  }

  it("restores every heading by position when the catalogue is configured", () => {
    const translated = catalogueOutline([
      "## Allgemein",
      "## Patient-DE",
      "## Beschwerde",
      "## Anamnese",
      "### Geschichte",
      "### Medikamente",
      "## Prozeduren",
    ]);

    const restored = restoreSkeletonHeadings(translated, {
      anamnesisCategories: categories,
    });

    const check = checkSkeleton(restored, { anamnesisCategories: categories });
    expect(check).toEqual({ ok: true });
    expect(restored.filter((s) => s.fixed).map((s) => s.text)).toEqual([
      ...outlineSkeleton({ anamnesisCategories: ["History", "Medication"] }),
    ]);
  });

  it("keeps the translated ### category text for a freeform catalogue, restoring only the five sections", () => {
    const translated = catalogueOutline([
      "## Allgemein",
      "## Patient-DE",
      "## Beschwerde",
      "## Anamnese",
      "### Übersetzte Kategorie",
      "## Prozeduren",
    ]);

    const restored = restoreSkeletonHeadings(translated, {
      anamnesisCategories: undefined,
    });

    expect(restored.filter((s) => s.fixed).map((s) => s.text)).toEqual([
      ...outlineSkeleton({ anamnesisCategories: ["Übersetzte Kategorie"] }),
    ]);
  });

  it("returns the outline unchanged when the fixed count is wrong", () => {
    const wrong = catalogueOutline(["## Allgemein", "## Prozeduren"]);
    const restored = restoreSkeletonHeadings(wrong, {
      anamnesisCategories: categories,
    });
    expect(restored).toEqual(wrong);
  });
});

describe("outlineSections", () => {
  const outline = (categories: string[]) =>
    parseTaggedOutline(
      [
        "<fixed>## General</fixed>\n\nGENERAL-NOTE",
        "<fixed>## Patient</fixed>\n\n58, male.",
        "<fixed>## Chief complaint</fixed>\n\nSharp pain.",
        "<fixed>## Anamnesis</fixed>\n\nNo relevant history.",
        ...categories.map((c) => `<fixed>### ${c}</fixed>\n\n${c} body.`),
        "<fixed>## Procedures</fixed>\n\nPROCEDURES-NOTE",
      ].join("\n\n")
    );

  it("slices patient, chief complaint, anamnesis (with category subsections) and procedures", () => {
    const sections = outlineSections(outline(["History", "Allergies"]));
    expect(sections).toEqual({
      patient: "58, male.",
      chiefComplaint: "Sharp pain.",
      anamnesis:
        "No relevant history.\n\n### History\n\nHistory body.\n\n### Allergies\n\nAllergies body.",
      procedures: "PROCEDURES-NOTE",
    });
    const all = Object.values(sections).join("\n");
    expect(all).not.toContain("GENERAL-NOTE");
  });

  it("works with zero categories", () => {
    expect(outlineSections(outline([]))).toEqual({
      patient: "58, male.",
      chiefComplaint: "Sharp pain.",
      anamnesis: "No relevant history.",
      procedures: "PROCEDURES-NOTE",
    });
  });
});

describe("freezeGeneral (#221)", () => {
  const outline = () =>
    parseTaggedOutline(
      [
        "<fixed>## General</fixed>\n\n  GENERAL-NOTE  ",
        "<fixed>## Patient</fixed>\n\n58, male.",
        "<fixed>## Chief complaint</fixed>\n\nSharp pain.",
        "<fixed>## Anamnesis</fixed>\n\nNo history.",
        "<fixed>## Procedures</fixed>\n\nNOTE",
      ].join("\n\n")
    );

  it("merges the General body into its fixed segment", () => {
    const frozen = freezeGeneral(outline());
    expect(frozen[1]).toEqual({
      fixed: true,
      text: "## General\n\nGENERAL-NOTE",
    });
    expect(frozen[2]).toEqual({ fixed: false, text: "" });
    expect(frozen).toHaveLength(outline().length);
    expect(isCanonicalShape(frozen)).toBe(true);
  });

  it("leaves a blank body as the bare heading", () => {
    const blank = outline();
    blank[2] = { fixed: false, text: "  " };
    const frozen = freezeGeneral(blank);
    expect(frozen[1]!.text).toBe("## General");
    expect(frozen[2]!.text).toBe("");
  });

  it("is idempotent", () => {
    const once = freezeGeneral(outline());
    expect(freezeGeneral(once)).toEqual(once);
  });

  it("checkSkeleton accepts a frozen General, rejects a body on Patient", () => {
    expect(checkSkeleton(freezeGeneral(outline()), {})).toEqual({ ok: true });
    const bad = outline();
    bad[3] = { fixed: true, text: "## Patient\n\nbody" };
    expect(checkSkeleton(bad, {}).ok).toBe(false);
  });

  it("restoreSkeletonHeadings keeps the General body and restores its heading", () => {
    const translated = freezeGeneral(outline());
    translated[1] = { fixed: true, text: "## Allgemein\n\nGENERAL-NOTE" };
    const restored = restoreSkeletonHeadings(translated, {});
    expect(restored[1]!.text).toBe("## General\n\nGENERAL-NOTE");
  });

  it("outlineSections ignores the freeze", () => {
    expect(outlineSections(freezeGeneral(outline()))).toEqual(
      outlineSections(outline())
    );
  });
});
