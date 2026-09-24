import { describe, expect, it } from "vitest";
import {
  ContentPartSchema,
  ContentPartsSchema,
  encodeText,
  textOf,
  textOfPart,
  type ContentPart,
} from "./ContentPart.js";

/** Fixture helper: `text/plain` part whose `value` is UTF-8 of `alt`. */
function fixtureTextPart(alt: string): ContentPart {
  return { type: "text/plain", value: encodeText(alt), alt };
}

describe("textOfPart", () => {
  it("decodes value for a text/plain part", () => {
    const part: ContentPart = {
      type: "text/plain",
      value: encodeText("Chest X-ray, PA. Consolidation noted."),
      alt: "Chest X-ray",
    };
    expect(textOfPart(part)).toBe("Chest X-ray, PA. Consolidation noted.");
  });

  it("decodes value for another text/* subtype", () => {
    const part: ContentPart = {
      type: "text/markdown",
      value: encodeText("**Impression:** pneumonia."),
      alt: "Impression",
    };
    expect(textOfPart(part)).toBe("**Impression:** pneumonia.");
  });

  it("falls back to alt for image/png", () => {
    const part: ContentPart = {
      type: "image/png",
      alt: "PA chest radiograph, right lower lobe consolidation.",
      value: new Uint8Array([137, 80, 78, 71]),
    };
    expect(textOfPart(part)).toBe(
      "PA chest radiograph, right lower lobe consolidation."
    );
  });

  it("falls back to alt for an unknown MIME type", () => {
    const part: ContentPart = {
      type: "application/x-unknown",
      alt: "An unrenderable placeholder.",
      value: new Uint8Array([1, 2, 3]),
    };
    expect(textOfPart(part)).toBe("An unrenderable placeholder.");
  });

  // Pins behaviour for `value === utf8(alt)` parts only; planner-authored parts may diverge.
  it("pins today's behaviour: for a part built the old textPart way (value === utf8(alt)), textOfPart returns exactly alt", () => {
    const part = fixtureTextPart("Chest X-ray, PA. Consolidation noted.");
    expect(textOfPart(part)).toBe(part.alt);
  });

  it("validates against ContentPartSchema", () => {
    expect(ContentPartSchema.safeParse(fixtureTextPart("hello")).success).toBe(
      true
    );
  });
});

describe("textOf — the only path from content parts to a prompt", () => {
  it("joins every part's text content with no explicit isText() branch at the call site", () => {
    const imagePart: ContentPart = {
      type: "image/png",
      alt: "PA chest radiograph, right lower lobe consolidation.",
      value: new Uint8Array([137, 80, 78, 71]),
    };

    const parts: ContentPart[] = [
      fixtureTextPart("Chest X-ray, PA. Consolidation noted."),
      imagePart,
      fixtureTextPart("Impression: right lower lobe pneumonia."),
    ];

    // Non-text part contributes `alt` (fallback), text part its decoded `value`.
    expect(textOf(parts)).toBe(
      [
        "Chest X-ray, PA. Consolidation noted.",
        "PA chest radiograph, right lower lobe consolidation.",
        "Impression: right lower lobe pneumonia.",
      ].join("\n\n")
    );
  });

  it("returns the alt of a single non-text part", () => {
    const imagePart: ContentPart = {
      type: "image/png",
      alt: "A radiograph.",
      value: new Uint8Array([1, 2, 3]),
    };

    expect(textOf([imagePart])).toBe("A radiograph.");
  });
});

describe("ContentPartsSchema — additive-parts semantics", () => {
  it("rejects an empty array: a field that exists has at least one part", () => {
    const result = ContentPartsSchema.safeParse([]);
    expect(result.success).toBe(false);
  });

  it("accepts a non-empty, order-preserving array", () => {
    const parts = [fixtureTextPart("a"), fixtureTextPart("b")];
    const result = ContentPartsSchema.safeParse(parts);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(parts);
  });
});
