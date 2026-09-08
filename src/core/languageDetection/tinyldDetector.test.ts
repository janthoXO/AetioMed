import { describe, expect, it } from "vitest";
import { createTinyldDetector } from "./tinyldDetector.js";

describe("createTinyldDetector — real tinyld, no network", () => {
  const detector = createTinyldDetector();

  it("detects English text with high confidence", () => {
    const result = detector.detect(
      "The patient complains of severe headache and fever for three days now."
    );
    expect(result?.iso).toBe("en");
    expect(result?.confidence).toBeGreaterThan(0.5);
  });

  it("detects German text with high confidence", () => {
    const result = detector.detect(
      "Der Patient klagt über starke Kopfschmerzen und Fieber seit drei Tagen."
    );
    expect(result?.iso).toBe("de");
    expect(result?.confidence).toBeGreaterThan(0.5);
  });

  it("returns undefined for text too short/ambiguous to have a candidate", () => {
    expect(detector.detect("Diabetes mellitus")).toBeUndefined();
  });
});
