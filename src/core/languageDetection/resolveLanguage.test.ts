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

// `runtime.llm.structured(...)` only reached by LLM fallback (step 3). Tests proving
// it is not reached pass this and assert `structuredSpy` never called.
function fakeRuntime(structuredSpy = vi.fn()): GraphRuntime {
  return { llm: { structured: structuredSpy } } as unknown as GraphRuntime;
}

const LONG_GERMAN_TEXT =
  "Bitte einen einfachen Fall mit klassischen Symptomen erstellen, danke.";

describe("resolveLanguage — step 1: explicit language", () => {
  it("wins outright, without invoking the detector", async () => {
    const detector = fakeDetector({ iso: "de", confidence: 1 });

    const result = await resolveLanguage({
      explicitLanguage: "fr",
      userInstructions: { general: LONG_GERMAN_TEXT },
      languages: ["en", "de", "fr"],
      autoDetect: true,
      llmFallbackEnabled: true,
      detector,
      runtime: fakeRuntime(),
    });

    expect(result).toBe("fr");
    expect(detector.detect).not.toHaveBeenCalled();
  });
});

describe("resolveLanguage — LANGUAGE_AUTO_DETECT unset", () => {
  it("falls straight to the configured default; the detector is never invoked", async () => {
    const detector = fakeDetector({ iso: "de", confidence: 1 });

    const result = await resolveLanguage({
      explicitLanguage: undefined,
      userInstructions: { general: LONG_GERMAN_TEXT },
      languages: ["en", "de"],
      autoDetect: false,
      llmFallbackEnabled: false,
      detector,
      runtime: fakeRuntime(),
    });

    expect(result).toBe("en");
    expect(detector.detect).not.toHaveBeenCalled();
  });
});

describe("resolveLanguage — step 2: the offline detector", () => {
  it("falls to the default with no userInstructions at all, without calling the detector", async () => {
    const detector = fakeDetector({ iso: "de", confidence: 1 });

    const result = await resolveLanguage({
      explicitLanguage: undefined,
      userInstructions: undefined,
      languages: ["en", "de"],
      autoDetect: true,
      llmFallbackEnabled: false,
      detector,
      runtime: fakeRuntime(),
    });

    expect(result).toBe("en");
    expect(detector.detect).not.toHaveBeenCalled();
  });

  it("resolves German instructions to German", async () => {
    const detector = fakeDetector({ iso: "de", confidence: 1 });

    const result = await resolveLanguage({
      explicitLanguage: undefined,
      userInstructions: { general: LONG_GERMAN_TEXT },
      languages: ["en", "de"],
      autoDetect: true,
      llmFallbackEnabled: false,
      detector,
      runtime: fakeRuntime(),
    });

    expect(result).toBe("de");
  });

  it("never passes the diagnosis name to the detector — only the concatenated userInstructions text", async () => {
    const detector = fakeDetector({ iso: "de", confidence: 1 });

    await resolveLanguage({
      explicitLanguage: undefined,
      userInstructions: {
        general: LONG_GERMAN_TEXT,
        anamnesis: "Weitere Hinweise zur Anamnese, bitte ausführlich.",
      },
      languages: ["en", "de"],
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
      languages: ["en", "de"],
      autoDetect: true,
      llmFallbackEnabled: false,
      detector,
      runtime: fakeRuntime(),
    });

    expect(result).toBe("en");
  });

  it("does not make an LLM call when auto-detect is on but the LLM fallback is off, even on a below-threshold result", async () => {
    const detector = fakeDetector({ iso: "de", confidence: 0.1 });
    const structuredSpy = vi.fn();

    await resolveLanguage({
      explicitLanguage: undefined,
      userInstructions: { general: LONG_GERMAN_TEXT },
      languages: ["en", "de"],
      autoDetect: true,
      llmFallbackEnabled: false,
      detector,
      runtime: fakeRuntime(structuredSpy),
    });

    expect(structuredSpy).not.toHaveBeenCalled();
  });

  it("a detected code outside the configured set never wins step 2", async () => {
    const detector = fakeDetector({ iso: "de", confidence: 1 });

    const result = await resolveLanguage({
      explicitLanguage: undefined,
      userInstructions: { general: LONG_GERMAN_TEXT },
      languages: ["en", "fr"],
      autoDetect: true,
      llmFallbackEnabled: false,
      detector,
      runtime: fakeRuntime(),
    });
    expect(result).toBe("en");
  });
});
