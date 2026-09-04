// Smoke test for the test harness itself (issue 00). Do NOT import anything
// under `src/core/graph/03repo/` from a test — those modules do filesystem
// and SQLite work at module scope (see `03repo/db.ts`, `symptoms.repo.ts`,
// and the module-scope `createTranslationStore(...)` calls in
// `procedures.repo.ts` / `anamnesis.repo.ts` / `labels.repo.ts`). Issues 01
// and 04 move that behind constructors; until then, keep tests to pure
// modules like this one.
import { describe, expect, it } from "vitest";

import {
  buildPrompt,
  renderUserInstructions,
  section,
} from "@/core/graph/utils/prompt.js";

describe("buildPrompt", () => {
  it("joins parts with blank lines between them", () => {
    expect(buildPrompt("first", "second", "third")).toBe(
      "first\n\nsecond\n\nthird"
    );
  });

  it("drops undefined parts", () => {
    expect(buildPrompt("first", undefined, "third")).toBe("first\n\nthird");
  });

  it("returns an empty string when every part is undefined", () => {
    expect(buildPrompt(undefined, undefined)).toBe("");
  });
});

describe("section", () => {
  it("renders a markdown-headed section when the body is non-empty", () => {
    expect(section("Header", "body text")).toBe("## Header\nbody text");
  });

  it("returns undefined for an empty body so it composes with buildPrompt", () => {
    expect(section("Header", "")).toBeUndefined();
    expect(section("Header", undefined)).toBeUndefined();
  });
});

describe("renderUserInstructions", () => {
  it("renders each entry as a key: value line", () => {
    expect(renderUserInstructions({ tone: "formal", length: "short" })).toBe(
      "tone: formal\nlength: short"
    );
  });

  it("filters out falsy values", () => {
    expect(
      renderUserInstructions({ tone: "formal", length: undefined, note: "" })
    ).toBe("tone: formal");
  });

  it("returns undefined when there is nothing to render", () => {
    expect(renderUserInstructions(undefined)).toBeUndefined();
    expect(renderUserInstructions({})).toBeUndefined();
    expect(renderUserInstructions({ a: undefined, b: "" })).toBeUndefined();
  });
});
