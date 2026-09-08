// Issue 11 §8.
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentPartTooLargeError,
  decodeCase,
  decodeContentPart,
  encodeCase,
  encodeContentPart,
} from "./contentWire.js";
import { textPart, type ContentPart } from "@/core/graph/models/ContentPart.js";
import type { Case } from "@/core/graph/models/Case.js";

afterEach(() => {});

const imagePart: ContentPart = {
  type: "image/png",
  alt: "PA chest radiograph, right lower lobe consolidation.",
  value: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]),
};

// Generous ceiling for the round-trip cases; the size-ceiling test passes
// its own tiny one. Config supplies this in production
// (`ConfigSchema.MAX_CONTENT_PART_BYTES`) — never `process.env` here.
const LIMIT = 5_000_000;

describe("ContentPart wire encoding", () => {
  it("serializes text/* to a readable UTF-8 string, not base64", () => {
    const wire = encodeContentPart(
      textPart("Cough for three days."),
      "chiefComplaint",
      LIMIT
    );
    expect(wire.type).toBe("text/plain");
    expect(wire.value).toBe("Cough for three days.");
  });

  it("omits alt on the wire for text/* parts", () => {
    const wire = encodeContentPart(
      textPart("Cough for three days."),
      "chiefComplaint",
      LIMIT
    );
    expect(wire.alt).toBeUndefined();
  });

  it("serializes a non-text part to base64 and keeps alt", () => {
    const wire = encodeContentPart(
      imagePart,
      "procedures[X-ray].result",
      LIMIT
    );
    expect(wire.type).toBe("image/png");
    expect(wire.value).toBe(Buffer.from(imagePart.value).toString("base64"));
    expect(wire.alt).toBe(imagePart.alt);
  });

  it("round-trips a mixed text/image/text array, order preserved", () => {
    const parts: ContentPart[] = [
      textPart("Chest X-ray ordered."),
      imagePart,
      textPart("Impression: right lower lobe pneumonia."),
    ];

    const wire = parts.map((p) => encodeContentPart(p, "result", LIMIT));
    const roundTripped = wire.map(decodeContentPart);

    expect(roundTripped).toEqual(parts);
  });

  it("restores alt on decode for a text/* part", () => {
    const wire = encodeContentPart(textPart("hello"), "chiefComplaint", LIMIT);
    const decoded = decodeContentPart(wire);
    expect(decoded.alt).toBe("hello");
    expect(new TextDecoder().decode(decoded.value)).toBe("hello");
  });

  it("fails loudly, naming the field and size, when a part exceeds the ceiling", () => {
    const oversized: ContentPart = {
      type: "image/png",
      alt: "big",
      value: new Uint8Array(10),
    };

    expect(() =>
      encodeContentPart(oversized, "procedures[MRI].result", 5)
    ).toThrow(ContentPartTooLargeError);
    try {
      encodeContentPart(oversized, "procedures[MRI].result", 5);
      throw new Error("expected encodeContentPart to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContentPartTooLargeError);
      expect((error as Error).message).toContain("procedures[MRI].result");
      expect((error as Error).message).toContain("10");
    }
  });
});

describe("Case wire encoding", () => {
  it("round-trips a full case losslessly, order preserved", () => {
    const generatedCase: Case = {
      patient: {
        name: "Jane",
        age: 40,
        height: 165,
        weight: 60,
        gender: "female",
      },
      chiefComplaint: [textPart("Cough for three days.")],
      anamnesis: [
        { category: "History", answer: [textPart("No prior illness.")] },
        {
          category: "Imaging",
          answer: [
            textPart("Ordered:"),
            imagePart,
            textPart("Findings above."),
          ],
        },
      ],
      procedures: [
        {
          name: "Chest X-ray",
          relevance: "obligatory",
          result: [textPart("Infiltrate in right lower lobe.")],
        },
      ],
    };

    const wire = encodeCase(generatedCase, LIMIT);
    expect(decodeCase(wire)).toEqual(generatedCase);
  });
});
