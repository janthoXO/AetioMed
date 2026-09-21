// Rewritten for #142: the old mock targeted `publishCaseGenerationResponse`,
// which no longer exists — results now publish through `publishCaseResult`
// (per-job subject, `cases.result.<jobId>`). Also covers the new `slot`
// plumbing (`Release`, from `core/concurrency.ts`) and the `msg.working()`
// heartbeat that keeps a long-running job's ack deadline alive.
//
// Rewritten again for #159 (plan mode): `getJetStreamClient` is mocked
// instead of `./cases.publisher.js` itself, so `publishStop`'s real subject
// routing (`cases.result.<jobId>` vs. `cases.review.<jobId>`) is exercised
// rather than assumed.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { JsMsg } from "@nats-io/jetstream";
import {
  consumeCaseGenerateMessage,
  runRequestWorker,
} from "./cases.handler.js";
import {
  WORKING_INTERVAL_MS,
  resultSubject,
  reviewSubject,
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

function fakeMsg(payload: unknown): JsMsg {
  return {
    json: () => payload,
    ack: vi.fn(),
    nak: vi.fn(),
    term: vi.fn(),
    working: vi.fn(),
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
  };
}

beforeEach(() => {
  publish.mockClear();
  publish.mockResolvedValue(undefined);
});

function publishedSubjects(): string[] {
  return publish.mock.calls.map((call) => call[0] as string);
}

describe("consumeCaseGenerateMessage (#142, #159)", () => {
  it("forwards difficulty, and passes the slot plus transport/onCheckpoint through to service.generate's 2nd arg", async () => {
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
    expect(opts).toMatchObject({ slot, transport: "nats" });
    expect(typeof opts!.onCheckpoint).toBe("function");
    expect(slot).toHaveBeenCalled();
  });

  it("acks at onCheckpoint, not at the end — and never acks twice", async () => {
    let onCheckpoint: (() => void) | undefined;
    const generate = vi.fn(
      (_req, opts) =>
        new Promise<CaseGenerationResult>((resolve) => {
          onCheckpoint = opts!.onCheckpoint;
          // Simulate the checkpoint firing mid-segment, well before the
          // segment's own result resolves.
          opts!.onCheckpoint?.();
          setTimeout(
            () => resolve({ jobId: "job-ck", status: "done", case: {} }),
            0
          );
        })
    );
    const service = fakeService(generate);
    const msg = fakeMsg({ jobId: "job-ck", diagnosis: "Influenza" });

    await consumeCaseGenerateMessage(msg, fakeGraph(), service);

    expect(onCheckpoint).toBeDefined();
    // ack() from onCheckpoint, plus the handler's own ack() after the
    // result — must collapse to exactly one real msg.ack() call.
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it("a plan-mode stop (awaiting_review) publishes the review to cases.review.<jobId>, not cases.result.<jobId>", async () => {
    const generate = vi.fn(
      async (): Promise<CaseGenerationResult> => ({
        jobId: "job-review",
        status: "awaiting_review",
        review: {
          jobId: "job-review",
          revision: 1,
          language: "English",
          outline: [{ fixed: false, text: "Chest pain." }],
          expiresAt: new Date().toISOString(),
        },
      })
    );
    const service = fakeService(generate);
    const msg = fakeMsg({ jobId: "job-review", diagnosis: "Influenza" });

    await consumeCaseGenerateMessage(msg, fakeGraph(), service);

    expect(publishedSubjects()).toEqual([reviewSubject("job-review")]);
    expect(publishedSubjects()).not.toContain(resultSubject("job-review"));
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
    // Neither `icd` nor `diagnosis` — fails the request schema's refine.
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

  it("publish throwing before the checkpoint acked: naks the message", async () => {
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

  it("publish throwing after the checkpoint already acked: never naks an acked message", async () => {
    publish.mockRejectedValueOnce(new Error("publish failed"));
    const generate = vi.fn(
      (_req, opts) =>
        new Promise<CaseGenerationResult>((resolve) => {
          opts!.onCheckpoint?.();
          resolve({ jobId: "job-fail-after-ack", status: "done", case: {} });
        })
    );
    const service = fakeService(generate);
    const msg = fakeMsg({
      jobId: "job-fail-after-ack",
      diagnosis: "Influenza",
    });

    await consumeCaseGenerateMessage(msg, fakeGraph(), service);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.nak).not.toHaveBeenCalled();
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

describe("consumeCaseGenerateMessage — msg.working() heartbeat (#142, #159)", () => {
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

    // Let the synchronous part of the handler run and register the interval.
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

  it("stops calling msg.working() once the checkpoint acks, even while generate is still pending", async () => {
    let onCheckpoint: (() => void) | undefined;
    let resolveGenerate!: (result: CaseGenerationResult) => void;
    const generate = vi.fn(
      (_req, opts) =>
        new Promise<CaseGenerationResult>((resolve) => {
          onCheckpoint = opts!.onCheckpoint;
          resolveGenerate = resolve;
        })
    );
    const service = fakeService(generate);
    const msg = fakeMsg({ jobId: "job-ck-working", diagnosis: "Influenza" });

    const pending = consumeCaseGenerateMessage(msg, fakeGraph(), service);
    await vi.advanceTimersByTimeAsync(0);

    onCheckpoint!();
    expect(msg.ack).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(WORKING_INTERVAL_MS * 3);
    expect(msg.working).not.toHaveBeenCalled();

    resolveGenerate({ jobId: "job-ck-working", status: "done", case: {} });
    await pending;
  });
});

// Sanity check that the module still exports the pull-worker entry point
// used by `index.ts` — not part of the acceptance criteria for this file,
// but a cheap guard against an accidental rename.
describe("runRequestWorker export", () => {
  it("is a function", () => {
    expect(typeof runRequestWorker).toBe("function");
  });
});
