// Issue 11 §8.
import { describe, expect, it } from "vitest";
import {
  ContentPartSchema,
  ContentPartsSchema,
  textOf,
  textPart,
  type ContentPart,
} from "./ContentPart.js";

describe("textPart", () => {
  it("derives value as the UTF-8 encoding of alt", () => {
    const part = textPart("Chest X-ray, PA. Consolidation noted.");

    expect(part.type).toBe("text/plain");
    expect(part.alt).toBe("Chest X-ray, PA. Consolidation noted.");
    expect(new TextDecoder().decode(part.value)).toBe(part.alt);
  });

  it("validates against ContentPartSchema", () => {
    expect(ContentPartSchema.safeParse(textPart("hello")).success).toBe(true);
  });
});

describe("textOf — the only path from content parts to a prompt", () => {
  it("joins every part's alt with no MIME branching", () => {
    const imagePart: ContentPart = {
      type: "image/png",
      alt: "PA chest radiograph, right lower lobe consolidation.",
      value: new Uint8Array([137, 80, 78, 71]),
    };

    const parts: ContentPart[] = [
      textPart("Chest X-ray, PA. Consolidation noted."),
      imagePart,
      textPart("Impression: right lower lobe pneumonia."),
    ];

    // A non-text part contributes its `alt` exactly like a text part does —
    // no `isText()` branch anywhere in `textOf`.
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
    const parts = [textPart("a"), textPart("b")];
    const result = ContentPartsSchema.safeParse(parts);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(parts);
  });
});
