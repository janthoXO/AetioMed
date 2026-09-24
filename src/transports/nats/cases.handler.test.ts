// Handler acks only after output published, naks on publish failure, and
// past `REQUEST_MAX_ATTEMPTS` deliveries publishes `RETRIES_EXHAUSTED`
// without calling service. Normal-mode plan published via `onPlan`, best-effort.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { JsMsg } from "@nats-io/jetstream";
import {
  consumeCaseGenerateMessage,
  runRequestWorker,
} from "./cases.handler.js";
import {
  WORKING_INTERVAL_MS,
  REQUEST_MAX_ATTEMPTS,
  resultSubject,
  planSubject,
} from "./subjects.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type {
  CaseGenerationService,
  CaseGenerationResult,
} from "@/core/caseGenerationService.js";
import type { Release } from "@/core/concurrency.js";

const publish = vi.fn().mockResolvedValue(undefined);
vi.mock("./client.js", () => ({
  getJetStreamClient: () => ({ publish }),
}));

import { planAndRenderFrom } from "@/testing/graphFakes.js";

function fakeMsg(payload: unknown, deliveryCount = 1): JsMsg {
  return {
    json: () => payload,
    ack: vi.fn(),
    nak: vi.fn(),
    term: vi.fn(),
    working: vi.fn(),
    info: { deliveryCount },
  } as unknown as JsMsg;
}

function fakeGraph(): GraphAppContext {
  return {
    config: {
      llm: {
        provider: "ollama",
        model: "test-model",
      },
      allowedLlms: undefined,
      PROCEDURE_PRESELECTION: false,
      LANGUAGES: ["English", "German"],
      LANGUAGE_AUTO_DETECT: false,
      LANGUAGE_DETECT_LLM_FALLBACK: false,
    } as GraphAppContext["config"],
    runtime: {} as GraphAppContext["runtime"],
    ...planAndRenderFrom(vi.fn()),
  } as unknown as GraphAppContext;
}

function fakeService(
  generate: CaseGenerationService["generate"]
): CaseGenerationService {
  return {
    generate,
    reserveSlot: vi.fn(),
    cancel: vi.fn(),
  } as unknown as CaseGenerationService;
}

beforeEach(() => {
  publish.mockClear();
  publish.mockResolvedValue(undefined);
});

function publishedSubjects(): string[] {
  return publish.mock.calls.map((call) => call[0] as string);
}

describe("consumeCaseGenerateMessage", () => {
  it("forwards difficulty, and passes the slot plus onPlan through to service.generate's 2nd arg", async () => {
    const generate = vi.fn(
      async (): Promise<CaseGenerationResult> => ({
        jobId: "job-1",
        status: "done",
        case: {},
      })
    );
    const service = fakeService(generate);
    const slot: Release = vi.fn();

    const msg = fakeMsg({
      jobId: "job-1",
      diagnosis: "Influenza",
      difficulty: "hard",
    });

    await consumeCaseGenerateMessage(msg, fakeGraph(), service, slot);

    expect(generate).toHaveBeenCalledTimes(1);
    const [request, opts] = generate.mock.calls[0]!;
    expect(request).toMatchObject({
      jobId: "job-1",
      diagnosis: "Influenza",
      difficulty: "hard",
    });
    expect(opts).toMatchObject({ slot });
    expect(typeof opts!.onPlan).toBe("function");
    expect(slot).toHaveBeenCalled();
  });

  it("acks only after the result is published, not before", async () => {
    let resolveGenerate!: (result: CaseGenerationResult) => void;
    const generate = vi.fn(
      () =>
        new Promise<CaseGenerationResult>((resolve) => {
          resolveGenerate = resolve;
        })
    );
    const service = fakeService(generate);
    const msg = fakeMsg({ jobId: "job-ck", diagnosis: "Influenza" });

    const pending = consumeCaseGenerateMessage(msg, fakeGraph(), service);
    await Promise.resolve();
    await Promise.resolve();
    expect(msg.ack).not.toHaveBeenCalled();

    resolveGenerate({ jobId: "job-ck", status: "done", case: {} });
    await pending;

    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it("a normal-mode plan is published through onPlan, best-effort, to cases.plan.<jobId>", async () => {
    const generate = vi.fn(async (_req, opts) => {
      opts!.onPlan!({
        jobId: "job-plan",
        mode: "normal",
        language: "English",
        plan: [{ fixed: false, text: "Chest pain." }],
      });
      return { jobId: "job-plan", status: "done", case: {} };
    });
    const service = fakeService(generate);
    const msg = fakeMsg({ jobId: "job-plan", diagnosis: "Influenza" });

    await consumeCaseGenerateMessage(msg, fakeGraph(), service);

    expect(publishedSubjects()).toContain(planSubject("job-plan"));
    expect(publishedSubjects()).toContain(resultSubject("job-plan"));
  });

  it("a plan-mode stop ('planned') publishes to cases.plan.<jobId>, not cases.result.<jobId>", async () => {
    const generate = vi.fn(
      async (): Promise<CaseGenerationResult> => ({
        jobId: "job-planned",
        status: "planned",
        language: "English",
        plan: [{ fixed: false, text: "Chest pain." }],
      })
    );
    const service = fakeService(generate);
    const msg = fakeMsg({ jobId: "job-planned", diagnosis: "Influenza" });

    await consumeCaseGenerateMessage(msg, fakeGraph(), service);

    expect(publishedSubjects()).toEqual([planSubject("job-planned")]);
    expect(publishedSubjects()).not.toContain(resultSubject("job-planned"));
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it("missing jobId: terminates the message, never publishes, never calls generate", async () => {
    const generate = vi.fn();
    const service = fakeService(generate);
    const msg = fakeMsg({ diagnosis: "Influenza" });

    await consumeCaseGenerateMessage(msg, fakeGraph(), service);

    expect(msg.term).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("jobId containing '.': terminates the message (it is a subject token)", async () => {
    const generate = vi.fn();
    const service = fakeService(generate);
    const msg = fakeMsg({ jobId: "job.1", diagnosis: "Influenza" });

    await consumeCaseGenerateMessage(msg, fakeGraph(), service);

    expect(msg.term).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("invalid body with a valid jobId: publishes INVALID_REQUEST_BODY to that jobId's result subject and acks", async () => {
    const generate = vi.fn();
    const service = fakeService(generate);
    // Neither `icd` nor `diagnosis`: fails schema refine.
    const msg = fakeMsg({ jobId: "job-bad-body" });

    await consumeCaseGenerateMessage(msg, fakeGraph(), service);

    expect(generate).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    const [subject, body] = publish.mock.calls[0]!;
    expect(subject).toBe(resultSubject("job-bad-body"));
    expect(JSON.parse(body as string)).toMatchObject({
      error: { code: "INVALID_REQUEST_BODY" },
    });
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it("a duplicate request: no publish (the owner already published), acks", async () => {
    const generate = vi.fn(
      async (): Promise<CaseGenerationResult> => ({
        jobId: "job-dup",
        status: "failed",
        error: { code: "JOB_ALREADY_ACTIVE", message: "already running" },
      })
    );
    const service = fakeService(generate);
    const msg = fakeMsg({ jobId: "job-dup", diagnosis: "Influenza" });

    await consumeCaseGenerateMessage(msg, fakeGraph(), service);

    expect(publish).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it("publish failing: naks the message, never acks", async () => {
    publish.mockRejectedValueOnce(new Error("publish failed"));
    const generate = vi.fn(
      async (): Promise<CaseGenerationResult> => ({
        jobId: "job-fail-publish",
        status: "done",
        case: { patient: { name: "Jane", age: 40, sex: "female" } },
      })
    );
    const service = fakeService(generate);
    const msg = fakeMsg({ jobId: "job-fail-publish", diagnosis: "Influenza" });

    await consumeCaseGenerateMessage(msg, fakeGraph(), service);

    expect(msg.nak).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("past REQUEST_MAX_ATTEMPTS deliveries: publishes RETRIES_EXHAUSTED and acks, without calling the service", async () => {
    const generate = vi.fn();
    const service = fakeService(generate);
    const msg = fakeMsg(
      { jobId: "job-exhausted", diagnosis: "Influenza" },
      REQUEST_MAX_ATTEMPTS + 1
    );

    await consumeCaseGenerateMessage(msg, fakeGraph(), service);

    expect(generate).not.toHaveBeenCalled();
    expect(publishedSubjects()).toEqual([resultSubject("job-exhausted")]);
    const [, body] = publish.mock.calls[0]!;
    expect(JSON.parse(body as string)).toMatchObject({
      error: { code: "RETRIES_EXHAUSTED" },
    });
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it("exactly REQUEST_MAX_ATTEMPTS deliveries still runs the service", async () => {
    const generate = vi.fn(
      async (): Promise<CaseGenerationResult> => ({
        jobId: "job-last-try",
        status: "done",
        case: {},
      })
    );
    const service = fakeService(generate);
    const msg = fakeMsg(
      { jobId: "job-last-try", diagnosis: "Influenza" },
      REQUEST_MAX_ATTEMPTS
    );

    await consumeCaseGenerateMessage(msg, fakeGraph(), service);

    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("releases the slot on every path: missing jobId, invalid body, duplicate, and success", async () => {
    const cases: {
      payload: unknown;
      generate: CaseGenerationService["generate"];
    }[] = [
      { payload: { diagnosis: "Influenza" }, generate: vi.fn() },
      {
        payload: { jobId: "job-a" },
        generate: vi.fn(),
      },
      {
        payload: { jobId: "job-b", diagnosis: "Influenza" },
        generate: vi.fn(
          async (): Promise<CaseGenerationResult> => ({
            jobId: "job-b",
            status: "failed",
            error: { code: "JOB_ALREADY_ACTIVE", message: "dup" },
          })
        ),
      },
      {
        payload: { jobId: "job-c", diagnosis: "Influenza" },
        generate: vi.fn(
          async (): Promise<CaseGenerationResult> => ({
            jobId: "job-c",
            status: "done",
            case: {},
          })
        ),
      },
    ];

    for (const { payload, generate } of cases) {
      const slot: Release = vi.fn();
      const service = fakeService(generate);
      const msg = fakeMsg(payload);

      await consumeCaseGenerateMessage(msg, fakeGraph(), service, slot);

      expect(slot).toHaveBeenCalled();
    }
  });
});

describe("consumeCaseGenerateMessage — msg.working() heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls msg.working() after WORKING_INTERVAL_MS while generate is pending, not after it resolves", async () => {
    let resolveGenerate!: (result: CaseGenerationResult) => void;
    const generate = vi.fn(
      () =>
        new Promise<CaseGenerationResult>((resolve) => {
          resolveGenerate = resolve;
        })
    );
    const service = fakeService(generate);
    const msg = fakeMsg({ jobId: "job-working", diagnosis: "Influenza" });

    const pending = consumeCaseGenerateMessage(msg, fakeGraph(), service);

    // Let sync part of handler run and register the interval.
    await vi.advanceTimersByTimeAsync(0);
    expect(msg.working).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WORKING_INTERVAL_MS);
    expect(msg.working).toHaveBeenCalledTimes(1);

    resolveGenerate({ jobId: "job-working", status: "done", case: {} });
    await pending;

    const callsAtResolve = vi.mocked(msg.working).mock.calls.length;
    await vi.advanceTimersByTimeAsync(WORKING_INTERVAL_MS * 2);
    expect(msg.working).toHaveBeenCalledTimes(callsAtResolve);
  });
});

// Guard: pull-worker entry point used by `index.ts` stays exported.
describe("runRequestWorker export", () => {
  it("is a function", () => {
    expect(typeof runRequestWorker).toBe("function");
  });
});
