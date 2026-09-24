// Laddered language resolver. Each rung tested in isolation; spy `LanguageDetector`
// stands in for `tinyld` to assert exact strings it sees.
import { describe, expect, it, vi } from "vitest";
import { resolveLanguage } from "./resolveLanguage.js";
import type { LanguageDetector } from "./port.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

function fakeDetector(
  result: { iso: string; confidence: number } | undefined
): LanguageDetector {
  return { detect: vi.fn().mockReturnValue(result) };
}

// `runtime.llm.for(...)` only reached by LLM fallback (step 3). Tests proving
// it is not reached pass this and assert `forSpy` never called.
function fakeRuntime(forSpy = vi.fn()): GraphRuntime {
  return { llm: { for: forSpy } } as unknown as GraphRuntime;
}

const LONG_GERMAN_TEXT =
  "Bitte einen einfachen Fall mit klassischen Symptomen erstellen, danke.";

describe("resolveLanguage — step 1: explicit language", () => {
  it("wins outright, without invoking the detector", async () => {
    const detector = fakeDetector({ iso: "de", confidence: 1 });

    const result = await resolveLanguage({
      explicitLanguage: "French",
      userInstructions: { general: LONG_GERMAN_TEXT },
      languages: ["English", "German", "French"],
      autoDetect: true,
      llmFallbackEnabled: true,
      detector,
      runtime: fakeRuntime(),
    });

    expect(result).toBe("French");
    expect(detector.detect).not.toHaveBeenCalled();
  });
});

describe("resolveLanguage — LANGUAGE_AUTO_DETECT unset", () => {
  it("falls straight to the configured default; the detector is never invoked", async () => {
    const detector = fakeDetector({ iso: "de", confidence: 1 });

    const result = await resolveLanguage({
      explicitLanguage: undefined,
      userInstructions: { general: LONG_GERMAN_TEXT },
      languages: ["English", "German"],
      autoDetect: false,
      llmFallbackEnabled: false,
      detector,
      runtime: fakeRuntime(),
    });

    expect(result).toBe("English");
    expect(detector.detect).not.toHaveBeenCalled();
  });
});

describe("resolveLanguage — step 2: the offline detector", () => {
  it("falls to the default with no userInstructions at all, without calling the detector", async () => {
    const detector = fakeDetector({ iso: "de", confidence: 1 });

    const result = await resolveLanguage({
      explicitLanguage: undefined,
      userInstructions: undefined,
      languages: ["English", "German"],
      autoDetect: true,
      llmFallbackEnabled: false,
      detector,
      runtime: fakeRuntime(),
    });

    expect(result).toBe("English");
    expect(detector.detect).not.toHaveBeenCalled();
  });

  it("resolves German instructions to German", async () => {
    const detector = fakeDetector({ iso: "de", confidence: 1 });

    const result = await resolveLanguage({
      explicitLanguage: undefined,
      userInstructions: { general: LONG_GERMAN_TEXT },
      languages: ["English", "German"],
      autoDetect: true,
      llmFallbackEnabled: false,
      detector,
      runtime: fakeRuntime(),
    });

    expect(result).toBe("German");
  });

  it("never passes the diagnosis name to the detector — only the concatenated userInstructions text", async () => {
    const detector = fakeDetector({ iso: "de", confidence: 1 });

    await resolveLanguage({
      explicitLanguage: undefined,
      userInstructions: {
        general: LONG_GERMAN_TEXT,
        anamnesis: "Weitere Hinweise zur Anamnese, bitte ausführlich.",
      },
      languages: ["English", "German"],
      autoDetect: true,
      llmFallbackEnabled: false,
      detector,
      runtime: fakeRuntime(),
    });

    // Detector saw only the `userInstructions` values, joined; never a diagnosis name.
    expect(detector.detect).toHaveBeenCalledTimes(1);
    expect(detector.detect).toHaveBeenCalledWith(
      `${LONG_GERMAN_TEXT} Weitere Hinweise zur Anamnese, bitte ausführlich.`
    );
  });

  it("falls to the default when the top candidate is below the confidence threshold", async () => {
    const detector = fakeDetector({ iso: "de", confidence: 0.1 });

    const result = await resolveLanguage({
      explicitLanguage: undefined,
      userInstructions: { general: LONG_GERMAN_TEXT },
      languages: ["English", "German"],
      autoDetect: true,
      llmFallbackEnabled: false,
      detector,
      runtime: fakeRuntime(),
    });

    expect(result).toBe("English");
  });

  it("does not make an LLM call when auto-detect is on but the LLM fallback is off, even on a below-threshold result", async () => {
    const detector = fakeDetector({ iso: "de", confidence: 0.1 });
    const forSpy = vi.fn();

    await resolveLanguage({
      explicitLanguage: undefined,
      userInstructions: { general: LONG_GERMAN_TEXT },
      languages: ["English", "German"],
      autoDetect: true,
      llmFallbackEnabled: false,
      detector,
      runtime: fakeRuntime(forSpy),
    });

    expect(forSpy).not.toHaveBeenCalled();
  });

  it("still works when passed explicitly, and never wins step 2, for a configured language the mapping table does not know", async () => {
    // "Klingon" absent from mapping.ts: cannot win step 2, usable at step 1.
    const detector = fakeDetector({ iso: "de", confidence: 1 });

    const viaDetection = await resolveLanguage({
      explicitLanguage: undefined,
      userInstructions: { general: LONG_GERMAN_TEXT },
      languages: ["English", "Klingon"],
      autoDetect: true,
      llmFallbackEnabled: false,
      detector,
      runtime: fakeRuntime(),
    });
    expect(viaDetection).toBe("English");

    const viaExplicit = await resolveLanguage({
      explicitLanguage: "Klingon",
      userInstructions: undefined,
      languages: ["English", "Klingon"],
      autoDetect: true,
      llmFallbackEnabled: false,
      detector,
      runtime: fakeRuntime(),
    });
    expect(viaExplicit).toBe("Klingon");
  });
});
