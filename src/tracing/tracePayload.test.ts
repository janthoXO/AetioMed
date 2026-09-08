// Issue 15 §1.3/§3/§6 — trace payloads get a size cap, not a node's full
// output, and bytes must never reach a trace event: `ContentPart[]` fields
// are projected through `textOf`, exactly as prompts do (issue 11 §4).
import { describe, expect, it } from "vitest";
import { textPart } from "@/core/graph/models/ContentPart.js";
import { buildTracePayload, sanitizeForTrace } from "./tracePayload.js";

describe("sanitizeForTrace — no ContentPart bytes ever reach a trace", () => {
  it("projects a ContentPart[] field to its textOf() text", () => {
    const parts = [textPart("First."), textPart("Second.")];
    const sanitized = sanitizeForTrace({ chiefComplaint: parts }) as {
      chiefComplaint: string;
    };

    expect(sanitized.chiefComplaint).toBe("First.\n\nSecond.");
    expect(sanitized.chiefComplaint).not.toBeInstanceOf(Uint8Array);
  });

  it("walks nested structures (anamnesis-shaped array of {category, answer})", () => {
    const sanitized = sanitizeForTrace({
      anamnesis: [{ category: "History", answer: [textPart("Cough.")] }],
    }) as { anamnesis: { category: string; answer: string }[] };

    expect(sanitized.anamnesis[0]).toEqual({
      category: "History",
      answer: "Cough.",
    });
  });

  it("never leaves a raw Uint8Array anywhere in the sanitized output", () => {
    const sanitized = sanitizeForTrace({
      weird: new Uint8Array([1, 2, 3]),
    }) as { weird: string };

    expect(typeof sanitized.weird).toBe("string");
    expect(sanitized.weird).not.toBeInstanceOf(Uint8Array);
  });

  it("leaves plain values (the common case — most node outputs) untouched", () => {
    expect(sanitizeForTrace({ a: 1, b: "text", c: [1, 2, 3] })).toEqual({
      a: 1,
      b: "text",
      c: [1, 2, 3],
    });
  });
});

describe("buildTracePayload — size cap, not full output (issue 15 §1.3)", () => {
  it("returns the value untouched (truncated: false) when under the cap", () => {
    const payload = buildTracePayload({ small: "value" }, 1000);
    expect(payload).toEqual({ truncated: false, value: { small: "value" } });
  });

  it("replaces an oversized payload with { truncated: true, bytes, preview }, never the raw value", () => {
    const big = { text: "x".repeat(1000) };
    const payload = buildTracePayload(big, 100);

    expect(payload.truncated).toBe(true);
    if (payload.truncated) {
      expect(payload.bytes).toBeGreaterThan(100);
      expect(payload.preview.length).toBeLessThanOrEqual(500);
      expect(payload.preview).toContain("xxxx");
    }
    // The marker replaces the payload — the full 1000-char string is not on it.
    expect(JSON.stringify(payload)).not.toContain("x".repeat(1000));
  });

  it("caps based on the sanitized (post-textOf) size, so a large ContentPart's bytes never inflate the reported size", () => {
    const hugeBinary = new Uint8Array(10_000_000); // way over any real cap
    const part = { type: "image/png", alt: "short caption", value: hugeBinary };
    const payload = buildTracePayload({ image: [part] }, 1000);

    // Sanitized to `textOf([part])` === "short caption" — tiny, well under
    // the cap, regardless of the original 10MB of pixel bytes.
    expect(payload).toEqual({
      truncated: false,
      value: { image: "short caption" },
    });
  });
});
