// Pure tests over validation.ts — no filesystem, no repo imports.
import { describe, expect, it } from "vitest";

import {
  findUnknownKeys,
  formatProblems,
  suggestNearest,
} from "@/core/graph/catalog/validation.js";

describe("findUnknownKeys", () => {
  it("a key present in the base catalogue produces no problem", () => {
    const problems = findUnknownKeys({
      catalogue: "procedures",
      file: "procedures.yml",
      baseKeys: ["Blood Test", "X-ray"],
      translations: { German: { "Blood Test": "Bluttest" } },
    });

    expect(problems).toEqual([]);
  });

  it("an unknown key produces a problem naming catalogue, file, language and key", () => {
    const problems = findUnknownKeys({
      catalogue: "procedures",
      file: "procedures.yml",
      baseKeys: ["Blood Test", "X-ray"],
      translations: { German: { "Blood Tset": "Bluttest" } },
    });

    expect(problems).toEqual([
      {
        catalogue: "procedures",
        file: "procedures.yml",
        language: "German",
        key: "Blood Tset",
        suggestion: "Blood Test",
      },
    ]);
  });

  it("reports all unknown keys, across multiple languages, not just the first", () => {
    const problems = findUnknownKeys({
      catalogue: "labels",
      file: "labelTranslations.yml",
      baseKeys: ["Generating patient"],
      translations: {
        German: { "Generating pateint": "x", "Yet Another Bogus Key": "y" },
        French: { "Generating pateint": "z" },
      },
    });

    expect(problems).toHaveLength(3);
    expect(problems.map((p) => `${p.language}:${p.key}`).sort()).toEqual(
      [
        "French:Generating pateint",
        "German:Generating pateint",
        "German:Yet Another Bogus Key",
      ].sort()
    );
  });

  it("an empty base catalogue yields no problems (not validated)", () => {
    const problems = findUnknownKeys({
      catalogue: "procedures",
      file: "procedures.yml",
      baseKeys: [],
      translations: { German: { Anything: "Etwas" } },
    });

    expect(problems).toEqual([]);
  });
});

describe("suggestNearest", () => {
  it("returns the near match at distance <= 3", () => {
    expect(
      suggestNearest("Choosing next procedur", ["Choosing next procedure"])
    ).toBe("Choosing next procedure");
  });

  it("returns undefined at distance 4", () => {
    // Same length, so the cheap length guard doesn't apply — this exercises
    // the actual Levenshtein distance (4 substitutions).
    expect(suggestNearest("abcd", ["wxyz"])).toBeUndefined();
  });
});

describe("formatProblems", () => {
  it("includes the Did you mean line only when there is a suggestion", () => {
    const withSuggestion = formatProblems([
      {
        catalogue: "labels",
        file: "labelTranslations.yml",
        language: "German",
        key: "Choosing next procedur",
        suggestion: "Choosing next procedure",
      },
    ]);
    expect(withSuggestion).toContain('Unknown key:  "Choosing next procedur"');
    expect(withSuggestion).toContain(
      'Did you mean: "Choosing next procedure"?'
    );

    const withoutSuggestion = formatProblems([
      {
        catalogue: "labels",
        file: "labelTranslations.yml",
        language: "German",
        key: "Totally Unrelated",
      },
    ]);
    expect(withoutSuggestion).not.toContain("Did you mean");
  });
});
