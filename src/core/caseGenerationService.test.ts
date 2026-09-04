// Proves issue 05's §5: terminal events ("Generation Completed"/"Failure"/
// "Cancelled") are emitted by CaseGenerationService itself, not by a
// transport — so a direct call with no transport involved still produces
// them. Before this refactor only the rest/nats extensions emitted these,
// so any other caller (this test included) got none.
import { describe, it, expect, vi } from "vitest";
import { EventBus } from "@/core/event-bus.js";
import { createCaseGenerationService } from "@/core/caseGenerationService.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import { AppError } from "@/core/graph/errors/AppError.js";
import type { Case } from "@/core/graph/models/Case.js";

function fakeGraph(
  generateCase: GraphAppContext["generateCase"]
): GraphAppContext {
  return {
    config: {
      llm: { provider: "ollama", model: "test-model", temperature: 0.7 },
      allowedLlms: undefined,
      LLM_SMALL: false,
    },
    runtime: {
      catalogs: {
        diagnosis: { byIcd: () => undefined },
      },
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
