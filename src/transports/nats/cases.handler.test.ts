// Rewritten for #142: the old mock targeted `publishCaseGenerationResponse`,
// which no longer exists — results now publish through `publishCaseResult`
// (per-job subject, `cases.result.<jobId>`). Also covers the new `slot`
// plumbing (`Release`, from `core/concurrency.ts`) and the `msg.working()`
// heartbeat that keeps a long-running job's ack deadline alive.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { JsMsg } from "@nats-io/jetstream";
import {
  consumeCaseGenerateMessage,
  runRequestWorker,
} from "./cases.handler.js";
import { WORKING_INTERVAL_MS } from "./subjects.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type {
  CaseGenerationService,
  CaseGenerationResult,
} from "@/core/caseGenerationService.js";
import type { Release } from "@/core/concurrency.js";

vi.mock("./cases.publisher.js", () => ({
  publishCaseResult: vi.fn().mockResolvedValue(undefined),
}));

import { publishCaseResult } from "./cases.publisher.js";

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
    generateCase: vi.fn(),
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
  vi.mocked(publishCaseResult).mockClear();
  vi.mocked(publishCaseResult).mockResolvedValue(undefined);
});

describe("consumeCaseGenerateMessage (#142)", () => {
  it("forwards difficulty and passes the slot through to service.generate's 2nd arg", async () => {
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
    expect(opts).toEqual({ slot });
    expect(slot).toHaveBeenCalled();
  });

  it("missing jobId: terminates the message, never publishes, never calls generate", async () => {
    const generate = vi.fn();
    const service = fakeService(generate);
    const msg = fakeMsg({ diagnosis: "Influenza" });

    await consumeCaseGenerateMessage(msg, fakeGraph(), service);

    expect(msg.term).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(publishCaseResult).not.toHaveBeenCalled();
  });

  it("jobId containing '.': terminates the message (it is a subject token)", async () => {
    const generate = vi.fn();
    const service = fakeService(generate);
    const msg = fakeMsg({ jobId: "job.1", diagnosis: "Influenza" });

    await consumeCaseGenerateMessage(msg, fakeGraph(), service);

    expect(msg.term).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    expect(publishCaseResult).not.toHaveBeenCalled();
  });

  it("invalid body with a valid jobId: publishes INVALID_REQUEST_BODY to that jobId and acks", async () => {
    const generate = vi.fn();
    const service = fakeService(generate);
    // Neither `icd` nor `diagnosis` — fails the request schema's refine.
    const msg = fakeMsg({ jobId: "job-bad-body" });

    await consumeCaseGenerateMessage(msg, fakeGraph(), service);

    expect(generate).not.toHaveBeenCalled();
    expect(publishCaseResult).toHaveBeenCalledTimes(1);
    const [jobId, response] = vi.mocked(publishCaseResult).mock.calls[0]!;
    expect(jobId).toBe("job-bad-body");
    expect(response).toMatchObject({
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

    expect(publishCaseResult).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it("publish throwing: naks the message", async () => {
    vi.mocked(publishCaseResult).mockRejectedValueOnce(
      new Error("publish failed")
    );
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

describe("consumeCaseGenerateMessage — msg.working() heartbeat (#142)", () => {
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
});

// Sanity check that the module still exports the pull-worker entry point
// used by `index.ts` — not part of the acceptance criteria for this file,
// but a cheap guard against an accidental rename.
describe("runRequestWorker export", () => {
  it("is a function", () => {
    expect(typeof runRequestWorker).toBe("function");
  });
});
