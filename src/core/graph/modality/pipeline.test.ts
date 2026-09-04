import { describe, expect, it } from "vitest";
import {
  defaultPlanFor,
  renderRequests,
  type ContentUnit,
} from "./pipeline.js";
import { createTextModalityProvider } from "./providers/text.js";
import type { ModalityProvider } from "./ports.js";

describe("defaultPlanFor (registry size 1 — no decide_modality node compiled)", () => {
  it("plans one request per unit, in the sole provider's MIME, carrying the unit's whole text", () => {
    const units: ContentUnit[] = [
      { key: "a", text: "Text A" },
      { key: "b", text: "Text B" },
    ];
    const plan = defaultPlanFor(units, [createTextModalityProvider()]);

    expect(plan).toEqual({
      a: [{ modality: "text/plain", alt: "Text A" }],
      b: [{ modality: "text/plain", alt: "Text B" }],
    });
  });

  it("throws when given an empty provider list", () => {
    expect(() => defaultPlanFor([{ key: "a", text: "x" }], [])).toThrow();
  });
});

describe("renderRequests", () => {
  it("resolves every request via its matching provider and carries the request's own alt", async () => {
    const image: ModalityProvider = {
      id: "image",
      produces: ["image/png"],
      render: async () => new TextEncoder().encode("bytes"),
    };

    const parts = await renderRequests(
      [createTextModalityProvider(), image],
      [
        { modality: "text/plain", alt: "hello" },
        { modality: "image/png", alt: "a picture of hello" },
      ],
      undefined
    );

    expect(parts).toEqual([
      {
        type: "text/plain",
        alt: "hello",
        value: new TextEncoder().encode("hello"),
      },
      {
        type: "image/png",
        alt: "a picture of hello",
        value: new TextEncoder().encode("bytes"),
      },
    ]);
  });

  it("orders results by PLANNED order, not completion order — the first-planned request resolves last (issue 13 §5)", async () => {
    const slow: ModalityProvider = {
      id: "slow",
      produces: ["application/x-slow"],
      async render(alt) {
        await new Promise((r) => setTimeout(r, 30));
        return new TextEncoder().encode(`slow:${alt}`);
      },
    };
    const fast: ModalityProvider = {
      id: "fast",
      produces: ["application/x-fast"],
      render: async (alt) => new TextEncoder().encode(`fast:${alt}`),
    };

    const parts = await renderRequests(
      [slow, fast],
      [
        { modality: "application/x-slow", alt: "first planned" },
        { modality: "application/x-fast", alt: "second planned" },
      ],
      undefined
    );

    expect(parts.map((p) => p.type)).toEqual([
      "application/x-slow",
      "application/x-fast",
    ]);
  });

  it("throws a descriptive error when no registered provider produces the requested modality", async () => {
    await expect(
      renderRequests(
        [createTextModalityProvider()],
        [{ modality: "image/png", alt: "x" }],
        undefined
      )
    ).rejects.toThrow(/image\/png/);
  });

  it("resolves with a fake non-LLM provider (render: async alt => encode(alt))", async () => {
    const fake: ModalityProvider = {
      id: "fake",
      produces: ["application/x-fake"],
      render: async (alt) => new TextEncoder().encode(alt),
    };

    const parts = await renderRequests(
      [fake],
      [{ modality: "application/x-fake", alt: "payload" }],
      undefined
    );

    expect(new TextDecoder().decode(parts[0].value)).toBe("payload");
  });
});
