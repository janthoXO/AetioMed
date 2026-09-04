import { describe, expect, it, vi } from "vitest";
import { detectLanguageViaLlm } from "./llmFallback.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

function fakeRuntime(invokeResult: unknown): {
  runtime: GraphRuntime;
  forSpy: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn().mockResolvedValue(invokeResult);
  const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
  const forSpy = vi.fn().mockReturnValue({ withStructuredOutput });
  return {
    runtime: { llm: { for: forSpy } } as unknown as GraphRuntime,
    forSpy,
  };
}

describe("detectLanguageViaLlm (issue 10 §1, step 3)", () => {
  it("returns the language the model picked", async () => {
    const { runtime, forSpy } = fakeRuntime({ language: "German" });

    const result = await detectLanguageViaLlm(runtime, "Bitte kurz halten.", [
      "English",
      "German",
    ]);

    expect(result).toBe("German");
    expect(forSpy).toHaveBeenCalledWith({
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
        for: vi.fn().mockReturnValue({
          withStructuredOutput: vi.fn().mockReturnValue({
            invoke: vi.fn().mockRejectedValue(new Error("model unreachable")),
          }),
        }),
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
