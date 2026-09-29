// Pure-module tests: no persistence imports.
import { describe, expect, it } from "vitest";

import {
  buildPrompt,
  buildSystemPrompt,
  boundLanguage,
  renderUserInstructions,
  section,
} from "./prompt.js";
import { requestContext } from "@/core/graph/utils/context.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

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

// `buildSystemPrompt` appends the directive for a foreign language;
// `boundLanguage` picks the language (runtime override, else ALS).
describe("buildSystemPrompt", () => {
  it("buildPrompt never adds a directive", () => {
    expect(buildPrompt("body text")).toBe("body text");
  });

  it("gets no directive for English", () => {
    expect(buildSystemPrompt("English", "body text")).not.toContain(
      "Output language"
    );
  });

  it("gets no directive when no language is given at all", () => {
    expect(buildSystemPrompt(undefined, "body text")).not.toContain(
      "Output language"
    );
  });

  it("gets the directive naming the foreign language", () => {
    const prompt = buildSystemPrompt("German", "body text");
    expect(prompt).toContain("Output language: German.");
    expect(prompt.startsWith("body text")).toBe(true);
  });
});

describe("boundLanguage", () => {
  const fakeRuntime = {} as GraphRuntime;

  function withLanguage<T>(language: string | undefined, fn: () => T): T {
    return requestContext.run({ language }, fn);
  }

  it("reads the ambient request language", () => {
    expect(withLanguage("German", () => boundLanguage(fakeRuntime))).toBe(
      "German"
    );
  });

  it("is undefined when no language is bound", () => {
    expect(withLanguage(undefined, () => boundLanguage(fakeRuntime))).toBe(
      undefined
    );
  });

  it("languageOverride: English wins over a foreign ambient language — the sandwich-on binding", () => {
    const englishOnlyRuntime = {
      languageOverride: "English",
    } as GraphRuntime;

    expect(
      withLanguage("German", () => boundLanguage(englishOnlyRuntime))
    ).toBe("English");
  });
});
