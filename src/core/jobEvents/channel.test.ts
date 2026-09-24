// Channel lifecycle, no transport involved. Teardown driven, never slept through.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKSTOP_MS,
  TOMBSTONE_MS,
  createJobEventChannel,
  type JobEvent,
} from "./index.js";

const label = (jobId: string, status: "started" | "completed") => ({
  jobId,
  nodeId: "n",
  status,
  label: "Doing a thing",
  timestamp: "t",
});

afterEach(() => {
  vi.useRealTimers();
});

describe("job event channel — subscribers", () => {
  it("two independent subscribers on one job both receive every event", () => {
    const channel = createJobEventChannel();
    channel.open("job");
    const a: JobEvent[] = [];
    const b: JobEvent[] = [];
    channel.subscribe("job", (e) => a.push(e));
    channel.subscribe("job", (e) => b.push(e));

    channel.publish("job", "label", label("job", "started"));
    channel.publish("job", "label", label("job", "completed"));
    channel.close("job", { status: "done" });

    expect(a.map((e) => e.type)).toEqual(["label", "label", "complete"]);
    expect(b).toEqual(a);
  });

  it("a global subscriber sees every job's whole lifecycle, from `accepted` to `complete`", () => {
    const channel = createJobEventChannel();
    const seen: [string, string][] = [];
    channel.subscribeAll((jobId, e) => seen.push([jobId, e.type]));

    channel.open("a");
    channel.open("b");
    channel.publish("a", "label", label("a", "started"));
    channel.close("b", { status: "cancelled" });

    expect(seen).toEqual([
      ["a", "accepted"],
      ["b", "accepted"],
      ["a", "label"],
      ["b", "complete"],
    ]);
  });

  it("a throwing subscriber does not stop delivery to the others", () => {
    const channel = createJobEventChannel();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    channel.open("job");
    const received: JobEvent[] = [];
    channel.subscribe("job", () => {
      throw new Error("bad adapter");
    });
    channel.subscribe("job", (e) => received.push(e));

    expect(() =>
      channel.publish("job", "label", label("job", "started"))
    ).not.toThrow();
    expect(received).toHaveLength(1);
    error.mockRestore();
  });

  it("events for a job that is not open are dropped, and nothing is delivered after `complete`", () => {
    const channel = createJobEventChannel();
    const seen: string[] = [];
    channel.subscribeAll((_jobId, e) => seen.push(e.type));

    channel.publish("never-opened", "label", label("never-opened", "started"));
    channel.open("job");
    channel.close("job", { status: "done" });
    channel.publish("job", "label", label("job", "started"));
    channel.close("job", { status: "done" });

    expect(seen).toEqual(["accepted", "complete"]);
  });
});

describe("job event channel — state and duplicates", () => {
  it("distinguishes active, terminal and unknown, and subscribing to a terminal job hands back its `complete`", () => {
    const channel = createJobEventChannel();
    expect(channel.subscribe("job", () => {})).toEqual({ state: "unknown" });

    channel.open("job");
    expect(channel.state("job")).toBe("active");

    channel.close("job", {
      status: "failed",
      error: { code: "GENERATION_FAILED", message: "boom" },
    });
    expect(channel.state("job")).toBe("terminal");
    expect(channel.subscribe("job", () => {})).toMatchObject({
      state: "terminal",
      complete: { jobId: "job", status: "failed" },
    });
  });

  it("rejects a jobId that is running or finished recently, and frees it once the tombstone expires", () => {
    vi.useFakeTimers();
    const channel = createJobEventChannel();

    expect(channel.open("job")).toBe(true);
    expect(channel.open("job")).toBe(false); // running

    channel.close("job", { status: "done" });
    expect(channel.open("job")).toBe(false); // finished recently

    vi.advanceTimersByTime(TOMBSTONE_MS);
    expect(channel.state("job")).toBe("unknown");
    expect(channel.open("job")).toBe(true);
  });
});

describe("job event channel — peek", () => {
  it("active job → {state: active}", () => {
    const channel = createJobEventChannel();
    channel.open("job");
    expect(channel.peek("job")).toEqual({ state: "active" });
  });

  it("terminal job → {state: terminal, complete}", () => {
    const channel = createJobEventChannel();
    channel.open("job");
    channel.close("job", { status: "done" });
    expect(channel.peek("job")).toMatchObject({
      state: "terminal",
      complete: { jobId: "job", status: "done" },
    });
  });

  it("unknown job → {state: unknown}", () => {
    const channel = createJobEventChannel();
    expect(channel.peek("nope")).toEqual({ state: "unknown" });
  });

  it("never subscribes: peeking a terminal job with no subscribers does not keep it alive", () => {
    const channel = createJobEventChannel();
    channel.open("job");
    channel.close("job", { status: "done" });
    // No subscribers at close, so already a tombstone. Peek must not hold a
    // subscription.
    expect(channel.peek("job")).toMatchObject({ state: "terminal" });
    expect(channel.peek("job")).toMatchObject({ state: "terminal" });
    channel.publish("job", "label", label("job", "started"));
    // Publish is a no-op post-close, unaffected by peek.
    expect(channel.peek("job")).toMatchObject({ state: "terminal" });
  });
});

describe("job event channel — reopening a jobId", () => {
  it("a jobId whose last outcome was 'planned' can be opened again", () => {
    const channel = createJobEventChannel();
    channel.open("job");
    channel.close("job", { status: "planned" });

    expect(channel.open("job")).toBe(true);
    expect(channel.state("job")).toBe("active");
  });

  it("a jobId whose last outcome was 'cancelled' can be opened again", () => {
    const channel = createJobEventChannel();
    channel.open("job");
    channel.close("job", { status: "cancelled" });

    expect(channel.open("job")).toBe(true);
    expect(channel.state("job")).toBe("active");
  });

  it("a jobId whose last outcome was 'done' cannot be reopened", () => {
    const channel = createJobEventChannel();
    channel.open("job");
    channel.close("job", { status: "done" });

    expect(channel.open("job")).toBe(false);
  });

  it("a jobId whose last outcome was 'failed' cannot be reopened", () => {
    const channel = createJobEventChannel();
    channel.open("job");
    channel.close("job", {
      status: "failed",
      error: { code: "GENERATION_FAILED", message: "boom" },
    });

    expect(channel.open("job")).toBe(false);
  });
});

describe("job event channel — deterministic teardown", () => {
  it("releases a terminal job the moment its last subscriber leaves", () => {
    const channel = createJobEventChannel();
    channel.open("job");
    const first = channel.subscribe("job", () => {});
    const second = channel.subscribe("job", () => {});
    if (first.state !== "active" || second.state !== "active") {
      throw new Error("expected active subscriptions");
    }

    channel.close("job", { status: "done" });
    first.unsubscribe();
    expect(channel.state("job")).toBe("terminal");

    second.unsubscribe();
    // Released but tombstoned: `terminal`, not `unknown`.
    expect(channel.state("job")).toBe("terminal");
  });

  it("a subscriber leaving before the job is terminal does not end the job", () => {
    const channel = createJobEventChannel();
    channel.open("job");
    const sub = channel.subscribe("job", () => {});
    if (sub.state !== "active") throw new Error("expected active");

    sub.unsubscribe();

    expect(channel.state("job")).toBe("active");
  });

  it("the backstop releases a terminal job whose subscriber never leaves", () => {
    vi.useFakeTimers();
    const channel = createJobEventChannel();
    channel.open("job");
    const received: JobEvent[] = [];
    channel.subscribe("job", (e) => received.push(e));
    channel.close("job", { status: "done" });

    vi.advanceTimersByTime(BACKSTOP_MS);
    // Hung subscriber detached; tombstone answers, expires on own schedule.
    vi.advanceTimersByTime(TOMBSTONE_MS);
    expect(channel.state("job")).toBe("unknown");
    expect(received.map((e) => e.type)).toEqual(["complete"]);
  });
});
