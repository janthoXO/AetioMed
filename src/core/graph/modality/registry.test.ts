import { describe, expect, it } from "vitest";
import {
  createModalityRegistry,
  findModalityProvider,
  producibleModalities,
} from "./registry.js";
import type { ModalityProvider } from "./ports.js";

describe("createModalityRegistry", () => {
  it("returns exactly the text provider today", () => {
    const registry = createModalityRegistry();
    expect(registry).toHaveLength(1);
    expect(registry[0].id).toBe("text");
    expect(registry[0].produces).toEqual(["text/plain"]);
  });
});

describe("findModalityProvider", () => {
  it("finds the first provider (registry order) that produces the requested MIME type", () => {
    const a: ModalityProvider = {
      id: "a",
      produces: ["image/png"],
      render: async () => new Uint8Array(),
    };
    const b: ModalityProvider = {
      id: "b",
      produces: ["text/plain", "image/png"],
      render: async () => new Uint8Array(),
    };

    expect(findModalityProvider([a, b], "image/png")?.id).toBe("a");
    expect(findModalityProvider([a, b], "text/plain")?.id).toBe("b");
    expect(findModalityProvider([a, b], "audio/mpeg")).toBeUndefined();
  });
});

describe("producibleModalities", () => {
  it("dedupes across providers, preserving registry order of first appearance", () => {
    const a: ModalityProvider = {
      id: "a",
      produces: ["text/plain", "image/png"],
      render: async () => new Uint8Array(),
    };
    const b: ModalityProvider = {
      id: "b",
      produces: ["image/png", "audio/mpeg"],
      render: async () => new Uint8Array(),
    };

    expect(producibleModalities([a, b])).toEqual([
      "text/plain",
      "image/png",
      "audio/mpeg",
    ]);
  });

  it("returns an empty array for an empty registry", () => {
    expect(producibleModalities([])).toEqual([]);
  });
});
