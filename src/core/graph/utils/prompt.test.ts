// Pure-module tests: no persistence imports.
import { describe, expect, it } from "vitest";

import {
  buildPrompt,
  buildSystemPrompt,
  renderUserInstructions,
  section,
} from "@/core/graph/utils/prompt.js";
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

// Language directive only for `"user-facing"` prompts with a foreign language
// bound, never when `runtime.languageOverride` forces English.
describe("buildSystemPrompt", () => {
  const fakeRuntime: GraphRuntime = {
    llm: {
      for: () => {
        throw new Error("prompt.test: must never call the LLM");
      },
    },
    catalogs: {} as GraphRuntime["catalogs"],
    log: { info() {}, warn() {}, error() {} },
    clock: () => new Date("2024-01-01T00:00:00.000Z"),
  };

  function withLanguage<T>(language: string | undefined, fn: () => T): T {
    return requestContext.run({ language }, fn);
  }

  it("internal roles get no directive even with a foreign language bound", () => {
    const prompt = withLanguage("German", () =>
      buildSystemPrompt(fakeRuntime, "internal", "body text")
    );
    expect(prompt).toBe("body text");
    expect(prompt).not.toContain("Output language");
  });

  it("user-facing roles get no directive for English", () => {
    const prompt = withLanguage("English", () =>
      buildSystemPrompt(fakeRuntime, "user-facing", "body text")
    );
    expect(prompt).not.toContain("Output language");
  });

  it("user-facing roles get no directive when no language is bound at all", () => {
    const prompt = withLanguage(undefined, () =>
      buildSystemPrompt(fakeRuntime, "user-facing", "body text")
    );
    expect(prompt).not.toContain("Output language");
  });

  it("user-facing roles get the directive naming the bound foreign language", () => {
    const prompt = withLanguage("German", () =>
      buildSystemPrompt(fakeRuntime, "user-facing", "body text")
    );
    expect(prompt).toContain("Output language: German.");
    expect(prompt.startsWith("body text")).toBe(true);
  });

  it("a runtime with languageOverride: English suppresses the directive even with a foreign ambient language — the sandwich-on binding", () => {
    const englishOnlyRuntime: GraphRuntime = {
      ...fakeRuntime,
      languageOverride: "English",
    };

    const prompt = withLanguage("German", () =>
      buildSystemPrompt(englishOnlyRuntime, "user-facing", "body text")
    );

    expect(prompt).not.toContain("Output language");
  });
});
