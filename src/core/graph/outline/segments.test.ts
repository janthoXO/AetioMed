import { describe, expect, it } from "vitest";
import {
  checkSkeleton,
  compareSubmission,
  isCanonicalShape,
  joinOutline,
  mergeSegments,
  normalizeSegmentText,
  OutlineFormatError,
  outlineSkeleton,
  OUTLINE_SECTIONS,
  parseTaggedOutline,
  renderTaggedOutline,
  restoreSkeletonHeadings,
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
  it("exposes the five fixed section headings", () => {
    expect(OUTLINE_SECTIONS).toEqual([
      "## General",
      "## Patient",
      "## Chief complaint",
      "## Anamnesis",
      "## Procedures",
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

describe("normalizeSegmentText", () => {
  it("converts CRLF and lone CR to LF", () => {
    expect(normalizeSegmentText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("normalizes decomposed accents to NFC", () => {
    const decomposed = "ü"; // "u" + combining diaeresis
    const composed = "ü"; // "ü"
    expect(normalizeSegmentText(decomposed)).toBe(composed);
  });

  it("strips trailing whitespace per line and trims the whole string", () => {
    expect(normalizeSegmentText("  line one   \nline two\t\n  ")).toBe(
      "line one\nline two"
    );
  });
});

describe("compareSubmission", () => {
  const display: OutlineSegments = [
    { fixed: false, text: "intro" },
    { fixed: true, text: "## General" },
    { fixed: false, text: "body" },
  ];

  it("reports SEGMENT_COUNT_MISMATCH when lengths differ", () => {
    const submitted = display.slice(0, 1);
    const result = compareSubmission(display, submitted);
    expect(result).toMatchObject({
      ok: false,
      code: "SEGMENT_COUNT_MISMATCH",
    });
  });

  it("reports FIXED_SEGMENT_CHANGED when a fixed heading's text changes", () => {
    const submitted: OutlineSegments = [
      display[0],
      { fixed: true, text: "## Changed" },
      display[2],
    ];
    const result = compareSubmission(display, submitted);
    expect(result).toMatchObject({
      ok: false,
      code: "FIXED_SEGMENT_CHANGED",
      index: 1,
    });
  });

  it("does not count a whitespace-only edit as changed", () => {
    const submitted: OutlineSegments = [
      { fixed: false, text: "  intro  \n" },
      display[1],
      display[2],
    ];
    const result = compareSubmission(display, submitted);
    expect(result).toEqual({ ok: true, changed: [] });
  });

  it("reports a real editable change by index", () => {
    const submitted: OutlineSegments = [
      { fixed: false, text: "rewritten intro" },
      display[1],
      display[2],
    ];
    const result = compareSubmission(display, submitted);
    expect(result).toEqual({ ok: true, changed: [0] });
  });
});

describe("mergeSegments", () => {
  const original: OutlineSegments = [
    { fixed: false, text: "old intro" },
    { fixed: true, text: "## General" },
    { fixed: false, text: "old body" },
  ];

  it("keeps fixed segments from original, ignoring a replacement aimed at one", () => {
    const merged = mergeSegments(original, new Map([[1, "## Tampered"]]));
    expect(merged[1]).toEqual({ fixed: true, text: "## General" });
  });

  it("applies replacements to editable segments by index", () => {
    const replacements = new Map([[2, "translated body"]]);
    const merged = mergeSegments(original, replacements);
    expect(merged).toEqual([
      { fixed: false, text: "old intro" },
      { fixed: true, text: "## General" },
      { fixed: false, text: "translated body" },
    ]);
  });

  it("falls back to original text for editable segments with no replacement", () => {
    const merged = mergeSegments(original, new Map());
    expect(merged).toEqual(original);
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
      ...OUTLINE_SECTIONS.slice(0, 4),
      "### History",
      "### Medication",
      OUTLINE_SECTIONS[4],
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
      ...OUTLINE_SECTIONS.slice(0, 4),
      "### Übersetzte Kategorie",
      OUTLINE_SECTIONS[4],
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
