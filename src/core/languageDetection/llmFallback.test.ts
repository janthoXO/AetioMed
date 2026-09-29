import { describe, expect, it, vi } from "vitest";
import { detectLanguageViaLlm } from "./llmFallback.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

function fakeRuntime(structuredResult: unknown): {
  runtime: GraphRuntime;
  structured: ReturnType<typeof vi.fn>;
} {
  const structured = vi.fn().mockResolvedValue(structuredResult);
  return {
    runtime: { llm: { structured } } as unknown as GraphRuntime,
    structured,
  };
}

describe("detectLanguageViaLlm (step 3)", () => {
  it("returns the language the model picked", async () => {
    const { runtime, structured } = fakeRuntime({ language: "German" });

    const result = await detectLanguageViaLlm(runtime, "Bitte kurz halten.", [
      "English",
      "German",
    ]);

    expect(result).toBe("German");
    expect(structured.mock.calls[0]![0]).toEqual({
      role: "translator",
      temperature: "deterministic",
    });
  });

  it('returns undefined when the model answers "none"', async () => {
    const { runtime } = fakeRuntime({ language: "none" });

    const result = await detectLanguageViaLlm(runtime, "???", [
      "English",
      "German",
    ]);

    expect(result).toBeUndefined();
  });

  it("returns undefined (never throws) when the model call fails", async () => {
    const runtime = {
      llm: {
        structured: vi.fn().mockRejectedValue(new Error("model unreachable")),
      },
    } as unknown as GraphRuntime;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await detectLanguageViaLlm(runtime, "text", [
      "English",
      "German",
    ]);

    expect(result).toBeUndefined();
  });
});
