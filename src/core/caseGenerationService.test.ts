// Proves issue 05's §5: terminal events ("Generation Completed"/"Failure"/
// "Cancelled") are emitted by CaseGenerationService itself, not by a
// transport — so a direct call with no transport involved still produces
// them. Before this refactor only the rest/nats transports emitted these,
// so any other caller (this test included) got none.
import { describe, it, expect, vi } from "vitest";
import { EventBus } from "@/core/event-bus.js";
import { createCaseGenerationService } from "@/core/caseGenerationService.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import { AppError } from "@/core/graph/errors/AppError.js";
import type { Case } from "@/core/graph/models/Case.js";
import { textPart } from "@/core/graph/models/ContentPart.js";
import type { LanguageDetector } from "@/core/languageDetection/port.js";

function fakeGraph(
  generateCase: GraphAppContext["generateCase"],
  configOverrides: Partial<GraphAppContext["config"]> = {}
): GraphAppContext {
  return {
    config: {
      llm: { provider: "ollama", model: "test-model", temperature: 0.7 },
      allowedLlms: undefined,
      PROCEDURE_PRESELECTION: false,
      LANGUAGES: ["English", "German"],
      LANGUAGE_AUTO_DETECT: false,
      LANGUAGE_DETECT_LLM_FALLBACK: false,
      ...configOverrides,
    } as GraphAppContext["config"],
    runtime: {
      catalogs: {
        diagnosis: { byIcd: () => undefined },
      },
      llm: { for: vi.fn() },
    } as unknown as GraphAppContext["runtime"],
    generateCase,
  };
}

describe("CaseGenerationService — terminal events, no transport involved", () => {
  it("emits 'Generation Completed' for a direct call that succeeds", async () => {
    const fakeCase: Case = {
      patient: { name: "Jane", age: 40, sex: "female" },
    };
    const graph = fakeGraph(async () => fakeCase);
    const bus = new EventBus();
    const onCompleted = vi.fn();
    bus.on("Generation Completed", onCompleted);

    const service = createCaseGenerationService(graph, bus);
    const result = await service.generate({
      diagnosis: "Influenza",
      generationFlags: [],
    });

    expect(result.status).toBe("done");
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onCompleted.mock.calls[0]?.[0]).toMatchObject({
      case: fakeCase,
      jobId: result.jobId,
    });
  });

  it("emits 'Generation Failure' for a direct call whose graph throws", async () => {
    const graph = fakeGraph(async () => {
      throw new AppError("boom", "GENERATION_FAILED", 500);
    });
    const bus = new EventBus();
    const onFailure = vi.fn();
    bus.on("Generation Failure", onFailure);

    const service = createCaseGenerationService(graph, bus);
    const result = await service.generate({
      diagnosis: "Influenza",
      generationFlags: [],
    });

    expect(result.status).toBe("failed");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ jobId: result.jobId });
  });

  it("emits 'Generation Cancelled' for a direct call the graph aborts", async () => {
    const graph = fakeGraph(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const bus = new EventBus();
    const onCancelled = vi.fn();
    bus.on("Generation Cancelled", onCancelled);

    const service = createCaseGenerationService(graph, bus);
    const result = await service.generate({
      diagnosis: "Influenza",
      generationFlags: [],
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("GENERATION_CANCELLED");
    expect(onCancelled).toHaveBeenCalledTimes(1);
    expect(onCancelled.mock.calls[0]?.[0]).toMatchObject({
      jobId: result.jobId,
    });
  });
});

describe("CaseGenerationService — generationFlags expansion and projection", () => {
  const fullCase: Case = {
    patient: { name: "Jane", age: 40, sex: "female" },
    chiefComplaint: [textPart("Cough for three days")],
    anamnesis: [{ category: "History", answer: [textPart("Nothing of note")] }],
    procedures: [
      { name: "CBC", relevance: "obligatory", result: [textPart("Normal")] },
    ],
  };

  it("generates the presentation internally for a procedures-only request, then projects it out", async () => {
    // The blinded solver reasons from the presentation, so it has to exist —
    // but the caller asked for procedures, so that is all they get back.
    const generateCase = vi.fn(async () => fullCase);
    const service = createCaseGenerationService(
      fakeGraph(generateCase),
      new EventBus()
    );

    const result = await service.generate({
      diagnosis: "Influenza",
      generationFlags: ["procedures"],
    });

    expect(generateCase.mock.calls[0]?.[0]?.generationFlags).toEqual([
      "procedures",
      "patient",
      "chiefComplaint",
      "anamnesis",
    ]);
    expect(result.case).toEqual({ procedures: fullCase.procedures });
  });

  it("passes a request that already names a presentation field through untouched", async () => {
    const generateCase = vi.fn(async () => fullCase);
    const service = createCaseGenerationService(
      fakeGraph(generateCase),
      new EventBus()
    );

    const result = await service.generate({
      diagnosis: "Influenza",
      generationFlags: ["procedures", "patient"],
    });

    expect(generateCase.mock.calls[0]?.[0]?.generationFlags).toEqual([
      "procedures",
      "patient",
    ]);
    // No expansion means no projection either — the case comes back as the
    // graph produced it.
    expect(result.case).toBe(fullCase);
  });
});

describe("CaseGenerationService — callerSuppliedFreeText provenance (issue 12 §3)", () => {
  const fullCase: Case = { patient: { name: "Jane", age: 40, sex: "female" } };

  it("is true when the request supplies a diagnosis name", async () => {
    const generateCase = vi.fn(async () => fullCase);
    const service = createCaseGenerationService(
      fakeGraph(generateCase),
      new EventBus()
    );

    await service.generate({ diagnosis: "Influenza", generationFlags: [] });

    expect(generateCase.mock.calls[0]?.[0]?.callerSuppliedFreeText).toBe(true);
  });

  it("is true when the request supplies userInstructions, even icd-only", async () => {
    const generateCase = vi.fn(async () => fullCase);
    const graph = fakeGraph(generateCase);
    graph.runtime = {
      catalogs: {
        diagnosis: { byIcd: () => ({ name: "Influenza" }) },
      },
    } as unknown as GraphAppContext["runtime"];
    const service = createCaseGenerationService(graph, new EventBus());

    await service.generate({
      icd: "1A00",
      generationFlags: [],
      userInstructions: { general: "Mach es einfach." },
    });

    expect(generateCase.mock.calls[0]?.[0]?.callerSuppliedFreeText).toBe(true);
  });

  it("is false for an icd-only request with no userInstructions", async () => {
    const generateCase = vi.fn(async () => fullCase);
    const graph = fakeGraph(generateCase);
    graph.runtime = {
      catalogs: {
        diagnosis: { byIcd: () => ({ name: "Influenza" }) },
      },
    } as unknown as GraphAppContext["runtime"];
    const service = createCaseGenerationService(graph, new EventBus());

    await service.generate({ icd: "1A00", generationFlags: [] });

    expect(generateCase.mock.calls[0]?.[0]?.callerSuppliedFreeText).toBe(false);
  });
});

describe("CaseGenerationService — language resolution (issue 10)", () => {
  const fullCase: Case = { patient: { name: "Jane", age: 40, sex: "female" } };

  function fakeDetector(
    result: { iso: string; confidence: number } | undefined
  ): LanguageDetector {
    return { detect: vi.fn().mockReturnValue(result) };
  }

  it("uses the explicit language and never invokes the detector", async () => {
    const generateCase = vi.fn(async () => fullCase);
    const detector = fakeDetector({ iso: "de", confidence: 1 });
    const graph = fakeGraph(generateCase, { LANGUAGE_AUTO_DETECT: true });
    const service = createCaseGenerationService(
      graph,
      new EventBus(),
      detector
    );

    const result = await service.generate({
      diagnosis: "Influenza",
      generationFlags: [],
      language: "German",
    });

    expect(detector.detect).not.toHaveBeenCalled();
    expect(generateCase.mock.calls[0]?.[0]?.language).toBe("German");
    expect(result.language).toBe("German");
  });

  it("defaults to English and skips detection with LANGUAGE_AUTO_DETECT unset", async () => {
    const generateCase = vi.fn(async () => fullCase);
    const detector = fakeDetector({ iso: "de", confidence: 1 });
    const graph = fakeGraph(generateCase); // LANGUAGE_AUTO_DETECT: false
    const service = createCaseGenerationService(
      graph,
      new EventBus(),
      detector
    );

    const result = await service.generate({
      diagnosis: "Influenza",
      generationFlags: [],
      userInstructions: {
        general: "Bitte einen einfachen Fall mit klassischen Symptomen.",
      },
    });

    expect(detector.detect).not.toHaveBeenCalled();
    expect(result.language).toBe("English");
  });

  it("resolves German userInstructions to German via the detector", async () => {
    const generateCase = vi.fn(async () => fullCase);
    const detector = fakeDetector({ iso: "de", confidence: 1 });
    const graph = fakeGraph(generateCase, { LANGUAGE_AUTO_DETECT: true });
    const service = createCaseGenerationService(
      graph,
      new EventBus(),
      detector
    );

    const result = await service.generate({
      diagnosis: "Influenza",
      generationFlags: [],
      userInstructions: {
        general: "Bitte einen einfachen Fall mit klassischen Symptomen.",
      },
    });

    expect(result.language).toBe("German");
    expect(generateCase.mock.calls[0]?.[0]?.language).toBe("German");
  });

  it("falls back to the default when detection confidence is below threshold", async () => {
    const generateCase = vi.fn(async () => fullCase);
    const detector = fakeDetector({ iso: "de", confidence: 0.1 });
    const graph = fakeGraph(generateCase, { LANGUAGE_AUTO_DETECT: true });
    const service = createCaseGenerationService(
      graph,
      new EventBus(),
      detector
    );

    const result = await service.generate({
      diagnosis: "Influenza",
      generationFlags: [],
      userInstructions: {
        general: "Bitte einen einfachen Fall mit klassischen Symptomen.",
      },
    });

    expect(result.language).toBe("English");
  });

  it("never passes the diagnosis name to the detector — only userInstructions", async () => {
    const generateCase = vi.fn(async () => fullCase);
    const detector = fakeDetector({ iso: "de", confidence: 1 });
    const graph = fakeGraph(generateCase, { LANGUAGE_AUTO_DETECT: true });
    const service = createCaseGenerationService(
      graph,
      new EventBus(),
      detector
    );

    await service.generate({
      diagnosis: "Diabetes mellitus",
      generationFlags: [],
      userInstructions: {
        general: "Bitte einen einfachen Fall mit klassischen Symptomen.",
      },
    });

    expect(detector.detect).toHaveBeenCalledTimes(1);
    expect(detector.detect).toHaveBeenCalledWith(
      "Bitte einen einfachen Fall mit klassischen Symptomen."
    );
    expect(detector.detect).not.toHaveBeenCalledWith(
      expect.stringContaining("Diabetes")
    );
  });

  it("does not make an LLM call when auto-detect is on but the LLM fallback is off", async () => {
    const generateCase = vi.fn(async () => fullCase);
    const detector = fakeDetector({ iso: "de", confidence: 0.1 });
    const forSpy = vi.fn();
    const graph = fakeGraph(generateCase, { LANGUAGE_AUTO_DETECT: true });
    graph.runtime = {
      ...graph.runtime,
      llm: { for: forSpy },
    } as GraphAppContext["runtime"];
    const service = createCaseGenerationService(
      graph,
      new EventBus(),
      detector
    );

    await service.generate({
      diagnosis: "Influenza",
      generationFlags: [],
      userInstructions: {
        general: "Bitte einen einfachen Fall mit klassischen Symptomen.",
      },
    });

    expect(forSpy).not.toHaveBeenCalled();
  });

  it("echoes the resolved language on a successful result", async () => {
    const generateCase = vi.fn(async () => fullCase);
    const graph = fakeGraph(generateCase);
    const service = createCaseGenerationService(graph, new EventBus());

    const result = await service.generate({
      diagnosis: "Influenza",
      generationFlags: [],
      language: "German",
    });

    expect(result.status).toBe("done");
    expect(result.language).toBe("German");
  });
});
