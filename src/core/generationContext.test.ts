import { describe, expect, it } from "vitest";
import { encodeText } from "@/core/graph/shared/domain/ContentPart.js";
import { encodeCase } from "@/api/contentWire.js";
import { caseUnits, partSources, pathKey } from "./generationContext.js";

const part = (alt: string, provider?: string) => ({
  type: "text/plain",
  value: encodeText(alt),
  alt,
  ...(provider && {
    source: { provider, input: { n: alt }, unit: `u-${alt}` },
  }),
});

describe("partSources", () => {
  const c = {
    chiefComplaint: [part("a", "text"), part("b", "referral")],
    anamnesis: [{ category: "Allergien", answer: [part("c", "text")] }],
    procedures: {
      categories: [],
      procedures: [
        {
          name: "ECG",
          order: 3,
          relevance: "obligatory" as const,
          result: [part("d"), part("e", "ecg")],
        },
      ],
    },
  };

  it("keys every sourced part by its client path; unsourced parts skipped", () => {
    const { parts, units } = partSources(caseUnits(c));
    expect(units).toEqual({
      [pathKey(["chiefComplaint"])]: "u-b",
      [pathKey(["anamnesis", "Allergien"])]: "u-c",
      [pathKey(["procedures", 3])]: "u-e",
    });
    expect(parts).toEqual({
      [pathKey(["chiefComplaint", 0])]: { provider: "text", input: { n: "a" } },
      [pathKey(["chiefComplaint", 1])]: {
        provider: "referral",
        input: { n: "b" },
      },
      [pathKey(["anamnesis", "Allergien", 0])]: {
        provider: "text",
        input: { n: "c" },
      },
      [pathKey(["procedures", 3, 1])]: { provider: "ecg", input: { n: "e" } },
    });
  });

  it("source never reaches the wire", () => {
    expect(encodeCase(c, 1_000_000).chiefComplaint![0]).not.toHaveProperty(
      "source"
    );
  });
});
