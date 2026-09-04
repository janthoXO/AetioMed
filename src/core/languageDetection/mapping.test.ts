import { describe, expect, it } from "vitest";
import { mapIsoToLanguage, unmappableLanguages } from "./mapping.js";

describe("mapIsoToLanguage", () => {
  it("maps a known ISO code to the configured language name", () => {
    expect(mapIsoToLanguage("de", ["English", "German"])).toBe("German");
  });

  it("is case-insensitive on the ISO code", () => {
    expect(mapIsoToLanguage("DE", ["English", "German"])).toBe("German");
  });

  it("returns undefined when the mapped name is not actually configured", () => {
    // The table knows French, but this deployment does not offer it.
    expect(mapIsoToLanguage("fr", ["English", "German"])).toBeUndefined();
  });

  it("returns undefined for an ISO code the table has no entry for", () => {
    expect(mapIsoToLanguage("xx", ["English", "German"])).toBeUndefined();
  });
});

describe("unmappableLanguages", () => {
  it("is empty when every configured language is in the table", () => {
    expect(unmappableLanguages(["English", "German", "French"])).toEqual([]);
  });

  it("names a configured language the table does not recognise", () => {
    // A deployer-invented/unsupported language name (issue 10 §4): it never
    // wins step 2 of the ladder, but startup only warns, never fails.
    expect(unmappableLanguages(["English", "Klingon"])).toEqual(["Klingon"]);
  });
});
