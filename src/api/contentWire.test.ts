// Issue 11 §8, issue 21 §8 (the alt data-loss fix).
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentPartTooLargeError,
  decodeCase,
  decodeContentPart,
  encodeCase,
  encodeContentPart,
} from "./contentWire.js";
import {
  encodeText,
  type ContentPart,
} from "@/core/graph/models/ContentPart.js";
import type { Case } from "@/core/graph/models/Case.js";

afterEach(() => {});

/** Local fixture builder — the pre-issue-21 `textPart()` constructor,
 * inlined at every real call site now; kept here only to keep these
 * fixtures readable. Produces a part whose `alt` equals its decoded
 * `value` — the shape every real generator still produces today. */
function fixtureTextPart(alt: string): ContentPart {
  return { type: "text/plain", value: encodeText(alt), alt };
}

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
      fixtureTextPart("Cough for three days."),
      "chiefComplaint",
      LIMIT
    );
    expect(wire.type).toBe("text/plain");
    expect(wire.value).toBe("Cough for three days.");
  });

  it("always emits alt on the wire, for text/* parts too (issue 21 §8)", () => {
    const wire = encodeContentPart(
      fixtureTextPart("Cough for three days."),
      "chiefComplaint",
      LIMIT
    );
    expect(wire.alt).toBe("Cough for three days.");
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
      fixtureTextPart("Chest X-ray ordered."),
      imagePart,
      fixtureTextPart("Impression: right lower lobe pneumonia."),
    ];

    const wire = parts.map((p) => encodeContentPart(p, "result", LIMIT));
    const roundTripped = wire.map(decodeContentPart);

    expect(roundTripped).toEqual(parts);
  });

  it("restores alt on decode for a text/* part", () => {
    const wire = encodeContentPart(
      fixtureTextPart("hello"),
      "chiefComplaint",
      LIMIT
    );
    const decoded = decodeContentPart(wire);
    expect(decoded.alt).toBe("hello");
    expect(new TextDecoder().decode(decoded.value)).toBe("hello");
  });

  // The issue 21 §8 regression: `alt` is no longer derivable from `value`
  // (a planner authors a short label distinct from the rendered prose), so
  // a text part whose `alt` differs from its `value` must round-trip with
  // BOTH fields intact — this is exactly the case the old "omit alt for
  // text/*, restore it as `value`" codec silently corrupted.
  it("round-trips a text part whose alt differs from its value, keeping both fields intact", () => {
    const part: ContentPart = {
      type: "text/plain",
      value: encodeText("Chest X-ray, PA view: left lower lobe consolidation."),
      alt: "Chest X-ray result",
    };

    const wire = encodeContentPart(part, "procedures[X-ray].result", LIMIT);
    expect(wire.alt).toBe("Chest X-ray result");
    expect(wire.value).toBe(
      "Chest X-ray, PA view: left lower lobe consolidation."
    );

    const decoded = decodeContentPart(wire);
    expect(decoded).toEqual(part);
    expect(decoded.alt).toBe("Chest X-ray result");
    expect(new TextDecoder().decode(decoded.value)).toBe(
      "Chest X-ray, PA view: left lower lobe consolidation."
    );
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
      chiefComplaint: [fixtureTextPart("Cough for three days.")],
      anamnesis: [
        { category: "History", answer: [fixtureTextPart("No prior illness.")] },
        {
          category: "Imaging",
          answer: [
            fixtureTextPart("Ordered:"),
            imagePart,
            fixtureTextPart("Findings above."),
          ],
        },
      ],
      procedures: [
        {
          name: "Chest X-ray",
          relevance: "obligatory",
          result: [fixtureTextPart("Infiltrate in right lower lobe.")],
        },
      ],
    };

    const wire = encodeCase(generatedCase, LIMIT);
    expect(decodeCase(wire)).toEqual(generatedCase);
  });
});
