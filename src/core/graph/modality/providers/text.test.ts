import { describe, expect, it } from "vitest";
import { createTextModalityProvider } from "./text.js";

describe("text modality provider", () => {
  it("is the degenerate case: utf8(alt), with no dependency capable of making an LLM call", async () => {
    const provider = createTextModalityProvider();

    expect(provider.id).toBe("text");
    expect(provider.produces).toEqual(["text/plain"]);

    // No `GraphRuntime`/`LlmPort` is even reachable from `render` — its only
    // inputs are `alt` and a `RenderContext` (signal/llmConfig), which is
    // exactly what makes "the text provider makes no LLM call" true by
    // construction rather than by a lucky implementation (issue 13 §3/§7).
    const bytes = await provider.render("hello world", {});
    expect(new TextDecoder().decode(bytes)).toBe("hello world");
  });

  it("round-trips arbitrary unicode text", async () => {
    const provider = createTextModalityProvider();
    const bytes = await provider.render("héllo — wörld 🩺", {});
    expect(new TextDecoder().decode(bytes)).toBe("héllo — wörld 🩺");
  });
});
