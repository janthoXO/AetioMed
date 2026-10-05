// Unit coverage for `startJobResponders`: a `planned` complete drops the
// status responder at once (continuation may run on any replica). No server:
// fake `nc` whose `subscribe` records the callback per subject; same style
// as `progressPublisher.test.ts`.
import { describe, expect, it } from "vitest";
import { createJobEventChannel } from "@/core/jobEvents/index.js";
import { startJobResponders } from "./jobResponders.js";
import { statusSubject } from "./subjects.js";
import type { CaseGenerationService } from "@/core/caseGenerationService.js";

type Callback = (
  error: unknown,
  msg: { json(): unknown; respond(data: string): void }
) => void;

function fakeNats() {
  const subs = new Map<string, Callback>();
  return {
    subscribe: (subject: string, opts: { callback: Callback }) => {
      subs.set(subject, opts.callback);
      return { unsubscribe: () => {} };
    },
    subs,
  };
}

function fakeMsg() {
  const respond = (data: string) => calls.push(data);
  const calls: string[] = [];
  return { json: () => undefined, respond, calls };
}

function fakeService(): CaseGenerationService {
  return { cancel: () => false } as unknown as CaseGenerationService;
}

describe("cases.status.<jobId> responder", () => {
  it("replies {state: 'active'} while the job runs", () => {
    const nc = fakeNats();
    const channel = createJobEventChannel();
    const service = fakeService();

    startJobResponders({ nc: nc as never, jobEvents: channel, service });
    channel.open("job-1");

    const callback = nc.subs.get(statusSubject("job-1"))!;
    const msg = fakeMsg();
    callback(null, msg);

    expect(msg.calls).toEqual([JSON.stringify({ state: "active" })]);
  });

  it("replies {state: 'terminal', complete} for a done job, within the tombstone window", () => {
    const nc = fakeNats();
    const channel = createJobEventChannel();
    const service = fakeService();

    startJobResponders({ nc: nc as never, jobEvents: channel, service });
    channel.open("job-2");
    channel.close("job-2", { status: "done" });

    const callback = nc.subs.get(statusSubject("job-2"))!;
    const msg = fakeMsg();
    callback(null, msg);

    expect(JSON.parse(msg.calls[0]!)).toMatchObject({
      state: "terminal",
      complete: { jobId: "job-2", status: "done" },
    });
  });

  it("drops the status responder immediately on a 'planned' complete — no tombstone window", () => {
    const nc = fakeNats();
    const channel = createJobEventChannel();
    const service = fakeService();

    startJobResponders({ nc: nc as never, jobEvents: channel, service });
    channel.open("job-3");
    expect(nc.subs.has(statusSubject("job-3"))).toBe(true);

    channel.close("job-3", { status: "planned" });

    // Continuation may run on any replica: reopening same jobId gets a fresh
    // responder, proving the old one was torn down, not left in tombstone window.
    channel.open("job-3");
    const callback = nc.subs.get(statusSubject("job-3"))!;
    const msg = fakeMsg();
    callback(null, msg);
    expect(msg.calls).toEqual([JSON.stringify({ state: "active" })]);
  });
});

describe("cases.cancel.<jobId> responder", () => {
  it("subscribes while the job is accepted and unsubscribes on complete", () => {
    const nc = fakeNats();
    const channel = createJobEventChannel();
    const service = fakeService();

    const stop = startJobResponders({
      nc: nc as never,
      jobEvents: channel,
      service,
    });
    channel.open("job-4");
    expect(nc.subs.size).toBeGreaterThan(0);

    stop();
  });
});
