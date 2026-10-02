import { describe, expect, it } from "vitest";
import {
  ContentPartSchema,
  ContentPartsSchema,
  altOf,
  encodeText,
  type ContentPart,
} from "./ContentPart.js";

/** Fixture helper: `text/plain` part whose `value` is UTF-8 of `alt`. */
function fixtureTextPart(alt: string): ContentPart {
  return { type: "text/plain", value: encodeText(alt), alt };
}

describe("altOf — the only path from content parts to a prompt", () => {
  it("joins every part's alt, whatever the MIME, and never reads value", () => {
    const parts: ContentPart[] = [
      {
        type: "text/plain",
        value: encodeText("Röntgen-Thorax: Konsolidierung rechts basal."),
        alt: "Chest X-ray: right lower lobe consolidation.",
      },
      {
        type: "image/png",
        alt: "PA chest radiograph, right lower lobe consolidation.",
        value: new Uint8Array([137, 80, 78, 71]),
      },
    ];

    expect(altOf(parts)).toBe(
      [
        "Chest X-ray: right lower lobe consolidation.",
        "PA chest radiograph, right lower lobe consolidation.",
      ].join("\n\n")
    );
  });

  it("validates against ContentPartSchema", () => {
    expect(ContentPartSchema.safeParse(fixtureTextPart("hello")).success).toBe(
      true
    );
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
