import { describe, expect, it } from "vitest";
import { languageName, promptLanguage } from "./Language.js";

describe("language names", () => {
  it("names a known code", () => {
    expect(languageName("de")).toBe("German");
  });

  it("returns undefined for an unknown or malformed code", () => {
    expect(languageName("xx")).toBeUndefined();
    expect(languageName("not a tag!")).toBeUndefined();
  });

  it("writes a prompt language as name and code", () => {
    expect(promptLanguage("de")).toBe("German (de)");
    expect(promptLanguage("xx")).toBe("xx (xx)");
  });
});
