import { describe, expect, it } from "vitest";
import { findModalityProvider } from "./registry.js";
import type { ModalityProvider } from "./ports.js";
import z from "zod";

function makeProvider(id: string, mime: string): ModalityProvider<unknown> {
  return {
    id,
    mime,
    description: `test provider ${id}`,
    inputSchema: z.unknown(),
    render: async () => [],
  };
}

describe("findModalityProvider", () => {
  it("finds a provider by id — never by MIME, since two providers may share one", () => {
    const a = makeProvider("a", "image/png");
    const b = makeProvider("b", "image/png");

    expect(findModalityProvider([a, b], "a")).toBe(a);
    expect(findModalityProvider([a, b], "b")).toBe(b);
    expect(findModalityProvider([a, b], "c")).toBeUndefined();
  });
});
