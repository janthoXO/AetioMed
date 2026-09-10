// Proves issue 05's §5: terminal events ("Generation Completed"/"Failure"/
// "Cancelled") are emitted by CaseGenerationService itself, not by a
// transport — so a direct call with no transport involved still produces
// them. Before this refactor only the rest/nats transports emitted these,
// so any other caller (this test included) got none.
import { describe, it, expect, vi } from "vitest";
import { EventBus } from "@/core/event-bus.js";
import { createCaseGenerationService } from "@/core/caseGenerationService.js";
import { createJobEventChannel } from "@/core/jobEvents/index.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import { AppError } from "@/core/graph/errors/AppError.js";
import type { Case } from "@/core/graph/models/Case.js";
import {
  encodeText,
  type ContentPart,
} from "@/core/graph/models/ContentPart.js";
import type { LanguageDetector } from "@/core/languageDetection/port.js";

function fakeGraph(
  generateCase: GraphAppContext["generateCase"],
  configOverrides: Partial<GraphAppContext["config"]> = {}
): GraphAppContext {
  return {
    config: {
      llm: { provider: "ollama", model: "test-model" },
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

    const service = createCaseGenerationService(
      graph,
      bus,
      createJobEventChannel()
    );
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

    const service = createCaseGenerationService(
      graph,
      bus,
      createJobEventChannel()
    );
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

    const service = createCaseGenerationService(
      graph,
      bus,
      createJobEventChannel()
    );
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

/** Local fixture builder — the pre-issue-21 `textPart()` constructor,
 * inlined at every real call site now; kept here only to keep this
 * fixture readable. */
function fixtureTextPart(alt: string): ContentPart {
  return { type: "text/plain", value: encodeText(alt), alt };
}

describe("CaseGenerationService — generationFlags expansion and projection", () => {
  const fullCase: Case = {
    patient: { name: "Jane", age: 40, sex: "female" },
    chiefComplaint: [fixtureTextPart("Cough for three days")],
    anamnesis: [
      { category: "History", answer: [fixtureTextPart("Nothing of note")] },
    ],
    procedures: [
      {
        name: "CBC",
        relevance: "obligatory",
        result: [fixtureTextPart("Normal")],
      },
    ],
  };

  it("generates the presentation internally for a procedures-only request, then projects it out", async () => {
    // The blinded solver reasons from the presentation, so it has to exist —
    // but the caller asked for procedures, so that is all they get back.
    const generateCase = vi.fn(async () => fullCase);
    const service = createCaseGenerationService(
      fakeGraph(generateCase),
      new EventBus(),
      createJobEventChannel()
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
      new EventBus(),
      createJobEventChannel()
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
      new EventBus(),
      createJobEventChannel()
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
    const service = createCaseGenerationService(
      graph,
      new EventBus(),
      createJobEventChannel()
    );

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
    const service = createCaseGenerationService(
      graph,
      new EventBus(),
      createJobEventChannel()
    );

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
      createJobEventChannel(),
      { detector }
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
      createJobEventChannel(),
      { detector }
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
      createJobEventChannel(),
      { detector }
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
      createJobEventChannel(),
      { detector }
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
      createJobEventChannel(),
      { detector }
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
      createJobEventChannel(),
      { detector }
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
    const service = createCaseGenerationService(
      graph,
      new EventBus(),
      createJobEventChannel()
    );

    const result = await service.generate({
      diagnosis: "Influenza",
      generationFlags: [],
      language: "German",
    });

    expect(result.status).toBe("done");
    expect(result.language).toBe("German");
  });
});

// #139 — the service owns each job's lifetime on the core-owned channel, so
// every transport sees the same lifecycle whatever door a request came in.
describe("CaseGenerationService — job channel lifecycle", () => {
  const minimalCase: Case = {
    patient: { name: "Jane", age: 40, sex: "female" },
  };

  it("opens the channel before its first await, so a caller can subscribe before any node runs", async () => {
    const channel = createJobEventChannel();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const service = createCaseGenerationService(
      fakeGraph(async () => {
        await gate;
        return minimalCase;
      }),
      new EventBus(),
      channel
    );

    const pending = service.generate({
      diagnosis: "Influenza",
      generationFlags: ["patient"],
      jobId: "job-sync-open",
    });

    // No `await` between calling `generate` and this line.
    expect(channel.state("job-sync-open")).toBe("active");
    const events: string[] = [];
    channel.subscribe("job-sync-open", (e) => events.push(e.type));

    release();
    await pending;
    expect(events).toEqual(["complete"]);
  });

  it("closes the channel with the outcome: done, cancelled, failed — including a request that fails before generation", async () => {
    const channel = createJobEventChannel();
    const completes: Record<string, unknown> = {};
    channel.subscribeAll((jobId, e) => {
      if (e.type === "complete") completes[jobId] = e.data;
    });
    const bus = new EventBus();
    const run = (
      generateCase: GraphAppContext["generateCase"],
      jobId: string
    ) =>
      createCaseGenerationService(
        fakeGraph(generateCase),
        bus,
        channel
      ).generate({
        diagnosis: "Influenza",
        generationFlags: ["patient"],
        jobId,
      });

    await run(async () => minimalCase, "done");
    await run(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }, "cancelled");
    await run(async () => {
      throw new AppError("boom", "GENERATION_FAILED", 500);
    }, "failed");
    await createCaseGenerationService(
      fakeGraph(async () => minimalCase),
      bus,
      channel
    ).generate({ icd: "XX00", generationFlags: ["patient"], jobId: "no-icd" });

    expect(completes["done"]).toMatchObject({ status: "done" });
    expect(completes["cancelled"]).toMatchObject({ status: "cancelled" });
    expect(completes["failed"]).toMatchObject({
      status: "failed",
      error: { code: "GENERATION_FAILED", message: "boom" },
    });
    expect(completes["no-icd"]).toMatchObject({
      status: "failed",
      error: { code: "INVALID_REQUEST_BODY" },
    });
    // The terminal marker never carries the case: an observer is not the
    // requester.
    expect(JSON.stringify(completes["done"])).not.toContain("Jane");
  });

  it("a duplicate jobId is rejected with 409 and never starts a second generation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const generateCase = vi.fn(async () => {
      await gate;
      return minimalCase;
    });
    const service = createCaseGenerationService(
      fakeGraph(generateCase),
      new EventBus(),
      createJobEventChannel()
    );
    const req = {
      diagnosis: "Influenza",
      generationFlags: ["patient" as const],
      jobId: "job-dup",
    };

    const first = service.generate(req);
    const whileRunning = await service.generate(req);
    release();
    await first;
    const afterFinishing = await service.generate(req);

    expect(generateCase).toHaveBeenCalledTimes(1);
    expect(whileRunning.error).toMatchObject({
      code: "JOB_ALREADY_ACTIVE",
      statusCode: 409,
    });
    expect(afterFinishing.error).toMatchObject({
      code: "JOB_ALREADY_COMPLETED",
      statusCode: 409,
    });
  });
});

// #142 — one limiter bounds generations across both transports. NATS holds
// its slot before calling `generate` (via `reserveSlot()`); REST lets
// `generate` acquire its own.
describe("CaseGenerationService — concurrency limit (#142)", () => {
  const minimalCase: Case = {
    patient: { name: "Jane", age: 40, sex: "female" },
  };

  /**
   * A `generateCase` that gates on an externally-controlled release and
   * records the maximum number of concurrently in-flight calls. Release is
   * FIFO by actual invocation order (not by name), so a caller does not need
   * to know which of several concurrent jobs happens to be running first.
   */
  function gatedGenerateCase() {
    let inFlight = 0;
    let maxInFlight = 0;
    const pending: (() => void)[] = [];
    const generateCase = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => pending.push(resolve));
      inFlight -= 1;
      return minimalCase;
    }) as unknown as GraphAppContext["generateCase"];
    return {
      generateCase,
      maxInFlight: () => maxInFlight,
      inFlightNow: () => inFlight,
      pendingCount: () => pending.length,
      releaseNext: () => pending.shift()?.(),
    };
  }

  async function waitUntil(predicate: () => boolean): Promise<void> {
    while (!predicate()) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("bounds concurrency identically over REST and NATS, all five finish 'done'", async () => {
    const { generateCase, maxInFlight, pendingCount, releaseNext } =
      gatedGenerateCase();
    const service = createCaseGenerationService(
      fakeGraph(generateCase),
      new EventBus(),
      createJobEventChannel(),
      { maxConcurrent: 2 }
    );

    // REST-style: generate() acquires its own slot. Not awaited here — the
    // point is that these run concurrently with the NATS-style jobs below,
    // all gated behind the same limiter.
    const restJobs = ["r1", "r2", "r3"].map((jobId) =>
      service.generate({
        diagnosis: jobId,
        generationFlags: ["patient"],
        jobId,
      })
    );
    // NATS-style: the caller reserves the slot up front, then hands it to
    // generate() — reserveSlot() itself waits for a free slot, so it is
    // chained rather than awaited at the top level (awaiting here would
    // block this test on a slot nothing has released yet).
    const natsJobs = ["n1", "n2"].map((jobId) =>
      service
        .reserveSlot()
        .then((slot) =>
          service.generate(
            { diagnosis: jobId, generationFlags: ["patient"], jobId },
            { slot }
          )
        )
    );

    // Release progressively: wait for at least one call to actually be
    // in-flight, then free it, five times over — this drains all five jobs
    // through the 2-wide limiter regardless of arrival order.
    for (let i = 0; i < 5; i++) {
      await waitUntil(() => pendingCount() > 0);
      releaseNext();
    }

    const results = await Promise.all([...restJobs, ...natsJobs]);
    expect(results.every((r) => r.status === "done")).toBe(true);
    expect(maxInFlight()).toBeLessThanOrEqual(2);
  });

  it("cancels a queued job without ever calling generateCase; its channel closes 'cancelled'", async () => {
    const { generateCase, releaseNext } = gatedGenerateCase();
    const channel = createJobEventChannel();
    const completes: Record<string, unknown> = {};
    channel.subscribeAll((jobId, e) => {
      if (e.type === "complete") completes[jobId] = e.data;
    });
    const service = createCaseGenerationService(
      fakeGraph(generateCase),
      new EventBus(),
      channel,
      { maxConcurrent: 1 }
    );

    const first = service.generate({
      diagnosis: "first",
      generationFlags: ["patient"],
      jobId: "first",
    });
    // Give `first` a tick to acquire its slot before queuing the second.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const queued = service.generate({
      diagnosis: "queued",
      generationFlags: ["patient"],
      jobId: "queued",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const cancelled = service.cancel("queued");
    expect(cancelled).toBe(true);

    const queuedResult = await queued;
    expect(queuedResult.error?.code).toBe("GENERATION_CANCELLED");

    releaseNext();
    await first;

    expect(generateCase).toHaveBeenCalledTimes(1);
    expect(completes["queued"]).toMatchObject({ status: "cancelled" });
  });

  it("releases a slot handed in when the job is rejected as a duplicate, so a following generate can still run", async () => {
    const { generateCase, inFlightNow, releaseNext } = gatedGenerateCase();
    // maxConcurrent: 2 so the duplicate's own reserved slot does not have to
    // wait behind the still-running "dup" job — the point under test is
    // whether that slot is released, not whether it was ever grantable.
    const service = createCaseGenerationService(
      fakeGraph(generateCase),
      new EventBus(),
      createJobEventChannel(),
      { maxConcurrent: 2 }
    );

    const dup = {
      diagnosis: "dup",
      generationFlags: ["patient" as const],
      jobId: "dup",
    };
    const first = service.generate(dup);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(inFlightNow()).toBe(1);

    // Second caller reserves a slot itself (NATS-style) and hands it to a
    // duplicate request; the service must release it since it never runs.
    const slot = await service.reserveSlot();
    const duplicateResult = await service.generate(dup, { slot });
    expect(duplicateResult.error?.code).toBe("JOB_ALREADY_ACTIVE");

    // Two slots exist; "dup" holds one. If the duplicate's slot leaked, both
    // are gone and "following" would queue forever instead of running.
    const following = service.generate({
      diagnosis: "following",
      generationFlags: ["patient"],
      jobId: "following",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(inFlightNow()).toBe(2);

    releaseNext(); // "dup"
    await first;
    releaseNext(); // "following"
    await following;
  });

  it("cancel('unknown') is false; cancel after finish is false", async () => {
    const service = createCaseGenerationService(
      fakeGraph(async () => minimalCase),
      new EventBus(),
      createJobEventChannel(),
      { maxConcurrent: 1 }
    );

    expect(service.cancel("unknown")).toBe(false);

    await service.generate({
      diagnosis: "done-job",
      generationFlags: ["patient"],
      jobId: "done-job",
    });
    expect(service.cancel("done-job")).toBe(false);
  });
});
