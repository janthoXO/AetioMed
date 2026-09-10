// #145 — the `JobDirectory` port and its local (in-process) implementation:
// watch, not collect (never a case), and cancel. `createBufferedWatch` is
// shared machinery, tested here directly since it has no state of its own
// beyond what its caller pushes into it.
import { describe, expect, it } from "vitest";
import {
  createBufferedWatch,
  createLocalJobDirectory,
  type WatchedEvent,
} from "./directory.js";
import { createJobEventChannel } from "./channel.js";

const label = (jobId: string, status: "started" | "completed") => ({
  jobId,
  nodeId: "n",
  status,
  label: "Doing a thing",
  timestamp: "t",
});

describe("createLocalJobDirectory — watch", () => {
  it("unknown jobId → {state: unknown}", async () => {
    const channel = createJobEventChannel();
    const directory = createLocalJobDirectory(channel, () => false);

    await expect(directory.watch("nope")).resolves.toEqual({
      state: "unknown",
    });
  });

  it("terminal jobId → {state: terminal, complete}", async () => {
    const channel = createJobEventChannel();
    channel.open("job");
    channel.close("job", { status: "done" });
    const directory = createLocalJobDirectory(channel, () => false);

    const result = await directory.watch("job");
    expect(result).toMatchObject({
      state: "terminal",
      complete: { jobId: "job", status: "done" },
    });
  });

  it("active: events published before listen are replayed in order, later ones delivered live, complete is delivered", async () => {
    const channel = createJobEventChannel();
    channel.open("job");
    const directory = createLocalJobDirectory(channel, () => false);

    const result = await directory.watch("job");
    if (result.state !== "active") throw new Error("expected active");

    // Published between `watch()` and `listen()` — must be buffered, not
    // lost.
    channel.publish("job", "label", label("job", "started"));

    const seen: WatchedEvent[] = [];
    const stop = result.listen((event) => seen.push(event));

    expect(seen.map((e) => e.type)).toEqual(["label"]);

    // Published after `listen()` — delivered live, appended in order.
    channel.publish("job", "label", label("job", "completed"));
    channel.close("job", { status: "done" });

    expect(seen.map((e) => e.type)).toEqual(["label", "label", "complete"]);
    stop();
  });

  it("the returned stop detaches: after close + stop, state stays terminal and a new subscriber gets the tombstone", async () => {
    const channel = createJobEventChannel();
    channel.open("job");
    const directory = createLocalJobDirectory(channel, () => false);

    const result = await directory.watch("job");
    if (result.state !== "active") throw new Error("expected active");
    const stop = result.listen(() => {});

    channel.close("job", { status: "done" });
    stop();

    expect(channel.state("job")).toBe("terminal");

    const second = await directory.watch("job");
    expect(second).toMatchObject({
      state: "terminal",
      complete: { jobId: "job", status: "done" },
    });
  });

  it("never includes `accepted`, and `complete`'s data never carries a case", async () => {
    const channel = createJobEventChannel();
    channel.open("job");
    const directory = createLocalJobDirectory(channel, () => false);

    const result = await directory.watch("job");
    if (result.state !== "active") throw new Error("expected active");

    const seen: WatchedEvent[] = [];
    result.listen((event) => seen.push(event));

    channel.publish("job", "label", label("job", "started"));
    channel.close("job", { status: "done" });

    expect(seen.every((e) => e.type !== "accepted")).toBe(true);
    const complete = seen.find((e) => e.type === "complete");
    expect(complete).toBeDefined();
    expect(Object.keys(complete!.data)).not.toContain("case");
  });
});

describe("createLocalJobDirectory — cancel", () => {
  it("a running job: cancelled, and the fake cancel fn was called", async () => {
    const channel = createJobEventChannel();
    channel.open("job");
    let called: string | undefined;
    const directory = createLocalJobDirectory(channel, (jobId) => {
      called = jobId;
      return true;
    });

    await expect(directory.cancel("job")).resolves.toBe("cancelled");
    expect(called).toBe("job");
  });

  it("a finished job: finished", async () => {
    const channel = createJobEventChannel();
    channel.open("job");
    channel.close("job", { status: "done" });
    const directory = createLocalJobDirectory(channel, () => false);

    await expect(directory.cancel("job")).resolves.toBe("finished");
  });

  it("never opened: unknown", async () => {
    const channel = createJobEventChannel();
    const directory = createLocalJobDirectory(channel, () => false);

    await expect(directory.cancel("nope")).resolves.toBe("unknown");
  });
});

describe("createBufferedWatch", () => {
  it("buffers events pushed before listen, then delivers live, in order", () => {
    const { push, watch } = createBufferedWatch(() => {});
    const early: WatchedEvent = {
      type: "label",
      data: label("job", "started"),
    };
    const late: WatchedEvent = {
      type: "label",
      data: label("job", "completed"),
    };

    push(early);

    const seen: WatchedEvent[] = [];
    watch.listen((event) => seen.push(event));
    expect(seen).toEqual([early]);

    push(late);
    expect(seen).toEqual([early, late]);
  });

  it("listen returns the stop fn passed to createBufferedWatch", () => {
    let stopped = false;
    const stop = () => (stopped = true);
    const { watch } = createBufferedWatch(stop);

    const returned = watch.listen(() => {});
    expect(returned).toBe(stop);
    expect(stopped).toBe(false);

    returned();
    expect(stopped).toBe(true);
  });
});
