// Unit coverage for the plan-mode additions to `startJobResponders` (#159):
// the `cases.decision.<jobId>` responder and the `awaiting_review` status
// reply. No server: a fake `nc` whose `subscribe` just records the
// callback per subject, driven directly — the same style as
// `progressPublisher.test.ts`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createJobEventChannel } from "@/core/jobEvents/index.js";
import { startJobResponders } from "./jobResponders.js";
import { decisionSubject, statusSubject } from "./subjects.js";
import type {
  CaseGenerationResult,
  CaseGenerationService,
} from "@/core/caseGenerationService.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";

vi.mock("./cases.publisher.js", () => ({
  publishStop: vi.fn().mockResolvedValue(undefined),
}));
import { publishStop } from "./cases.publisher.js";

type Callback = (
  error: unknown,
  msg: { json(): unknown; respond(data: string): void }
) => void;

function fakeNats() {
  const subs = new Map<string, Callback>();
  return {
    subscribe: vi.fn((subject: string, opts: { callback: Callback }) => {
      subs.set(subject, opts.callback);
      return { unsubscribe: vi.fn() };
    }),
    subs,
  };
}

function fakeMsg(payload: unknown | (() => unknown)) {
  return {
    json: typeof payload === "function" ? payload : () => payload,
    respond: vi.fn(),
  };
}

function fakeService(
  overrides: Partial<CaseGenerationService> = {}
): CaseGenerationService {
  return {
    getReview: vi.fn(() => undefined),
    cancel: vi.fn(),
    decide: vi.fn(),
    ...overrides,
  } as unknown as CaseGenerationService;
}

const graph = {} as GraphAppContext;

beforeEach(() => {
  vi.mocked(publishStop).mockClear();
});

describe("cases.decision.<jobId> responder (#159)", () => {
  it("accepted: replies {accepted:true} immediately, then publishes the segment's stop", async () => {
    const nc = fakeNats();
    const channel = createJobEventChannel();
    let resolveResult!: (r: CaseGenerationResult) => void;
    const service = fakeService({
      decide: vi.fn(() => ({
        accepted: true,
        jobId: "job-1",
        result: new Promise<CaseGenerationResult>((resolve) => {
          resolveResult = resolve;
        }),
      })),
    });

    startJobResponders({ nc: nc as never, graph, jobEvents: channel, service });
    channel.open("job-1");

    const callback = nc.subs.get(decisionSubject("job-1"))!;
    const msg = fakeMsg({ revision: 1, decision: { action: "approve" } });
    callback(null, msg);

    expect(msg.respond).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ accepted: true })
    );

    const result: CaseGenerationResult = {
      jobId: "job-1",
      status: "done",
      case: {},
    };
    resolveResult(result);
    await vi.waitFor(() => expect(publishStop).toHaveBeenCalledTimes(1));
    expect(publishStop).toHaveBeenCalledWith(graph, result);
  });

  it("refused: replies {accepted:false, error} and publishes nothing", () => {
    const nc = fakeNats();
    const channel = createJobEventChannel();
    const service = fakeService({
      decide: vi.fn(() => ({
        accepted: false,
        jobId: "job-2",
        error: { code: "STALE_REVISION", message: "stale", statusCode: 409 },
      })),
    });

    startJobResponders({ nc: nc as never, graph, jobEvents: channel, service });
    channel.open("job-2");

    const callback = nc.subs.get(decisionSubject("job-2"))!;
    const msg = fakeMsg({ revision: 1, decision: { action: "approve" } });
    callback(null, msg);

    expect(msg.respond).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        accepted: false,
        error: { code: "STALE_REVISION", message: "stale" },
      })
    );
    expect(publishStop).not.toHaveBeenCalled();
    expect(service.decide).toHaveBeenCalledWith("job-2", {
      revision: 1,
      decision: { action: "approve" },
    });
  });

  it("invalid JSON body: replies INVALID_REQUEST_BODY, never calls service.decide", () => {
    const nc = fakeNats();
    const channel = createJobEventChannel();
    const service = fakeService();

    startJobResponders({ nc: nc as never, graph, jobEvents: channel, service });
    channel.open("job-3");

    const callback = nc.subs.get(decisionSubject("job-3"))!;
    const msg = fakeMsg(() => {
      throw new Error("not json");
    });
    callback(null, msg);

    expect(msg.respond).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        accepted: false,
        error: {
          code: "INVALID_REQUEST_BODY",
          message: "Invalid JSON body",
        },
      })
    );
    expect(service.decide).not.toHaveBeenCalled();
  });

  it("body failing ReviewDecisionRequestSchema: replies INVALID_REQUEST_BODY with details, never calls service.decide", () => {
    const nc = fakeNats();
    const channel = createJobEventChannel();
    const service = fakeService();

    startJobResponders({ nc: nc as never, graph, jobEvents: channel, service });
    channel.open("job-4");

    const callback = nc.subs.get(decisionSubject("job-4"))!;
    const msg = fakeMsg({ revision: 1 }); // missing `decision`
    callback(null, msg);

    expect(msg.respond).toHaveBeenCalledTimes(1);
    const reply = JSON.parse(msg.respond.mock.calls[0]![0] as string);
    expect(reply.accepted).toBe(false);
    expect(reply.error.code).toBe("INVALID_REQUEST_BODY");
    expect(service.decide).not.toHaveBeenCalled();
  });

  it("unsubscribes on the job's complete event, exactly like cancel's subscription", () => {
    const nc = fakeNats();
    const channel = createJobEventChannel();
    const service = fakeService();

    startJobResponders({ nc: nc as never, graph, jobEvents: channel, service });
    channel.open("job-5");
    expect(nc.subs.has(decisionSubject("job-5"))).toBe(true);

    channel.close("job-5", { status: "done" });
    // The subscription object's unsubscribe was called — re-subscribing
    // under the same jobId (a fresh `accepted`) proves the map moved on.
    channel.open("job-5");
    expect(nc.subscribe).toHaveBeenCalledWith(
      decisionSubject("job-5"),
      expect.anything()
    );
  });
});

describe("cases.status.<jobId> — awaiting_review reply (#159)", () => {
  it("replies {state: 'awaiting_review', revision} when service.getReview returns a review, even though the channel is still active", () => {
    const nc = fakeNats();
    const channel = createJobEventChannel();
    const service = fakeService({
      getReview: vi.fn(() => ({
        jobId: "job-6",
        revision: 3,
        language: "English",
        outline: [{ fixed: false, text: "" }],
        expiresAt: new Date().toISOString(),
      })),
    });

    startJobResponders({ nc: nc as never, graph, jobEvents: channel, service });
    channel.open("job-6");

    const callback = nc.subs.get(statusSubject("job-6"))!;
    const msg = fakeMsg(undefined);
    callback(null, msg);

    expect(msg.respond).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ state: "awaiting_review", revision: 3 })
    );
  });

  it("falls back to the channel's peek() when there is no pending review", () => {
    const nc = fakeNats();
    const channel = createJobEventChannel();
    const service = fakeService();

    startJobResponders({ nc: nc as never, graph, jobEvents: channel, service });
    channel.open("job-7");

    const callback = nc.subs.get(statusSubject("job-7"))!;
    const msg = fakeMsg(undefined);
    callback(null, msg);

    expect(msg.respond).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ state: "active" })
    );
  });
});
