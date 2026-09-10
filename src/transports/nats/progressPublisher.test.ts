// Unit coverage for the progress publisher (#144). No server: a fake `nc`
// with a `publish` spy, driven against a real `JobEventChannel`.
import { describe, expect, it, vi } from "vitest";
import { createJobEventChannel } from "@/core/jobEvents/index.js";
import { progressSubject } from "./subjects.js";
import { startProgressPublisher } from "./progressPublisher.js";

// Deliberately not importing anything from `client.ts` — asserted at module
// scope below — and the fake `nc` here carries no jetstream client at all,
// so a jetstream import couldn't even be exercised through it.
function fakeNats() {
  return { publish: vi.fn() };
}

describe("startProgressPublisher (#144)", () => {
  it("publishes accepted, label and complete in order, as JSON, to cases.progress.<id>.<type>", () => {
    const nc = fakeNats();
    const channel = createJobEventChannel();
    const stop = startProgressPublisher({
      nc: nc as never,
      jobEvents: channel,
    });

    channel.open("job-1");
    channel.publish("job-1", "label", {
      jobId: "job-1",
      nodeId: "n1",
      status: "started",
      label: "Doing a thing",
      timestamp: "t1",
    });
    channel.close("job-1", { status: "done" });

    expect(nc.publish).toHaveBeenCalledTimes(3);

    const [subjects, payloads] = [
      nc.publish.mock.calls.map((c) => c[0]),
      nc.publish.mock.calls.map((c) => JSON.parse(c[1] as string)),
    ];

    expect(subjects).toEqual([
      progressSubject("job-1", "accepted"),
      progressSubject("job-1", "label"),
      progressSubject("job-1", "complete"),
    ]);
    expect(payloads[0]).toMatchObject({ jobId: "job-1" });
    expect(payloads[1]).toMatchObject({ nodeId: "n1", status: "started" });
    expect(payloads[2]).toMatchObject({ jobId: "job-1", status: "done" });

    stop();
  });

  it("publishes nothing for an invalid jobId (a subject token violation)", () => {
    const nc = fakeNats();
    const channel = createJobEventChannel();
    startProgressPublisher({ nc: nc as never, jobEvents: channel });

    channel.open("a.b");
    channel.close("a.b", { status: "done" });

    expect(nc.publish).not.toHaveBeenCalled();
  });

  it("a throwing publish does not throw out of channel.publish", () => {
    const nc = {
      publish: vi.fn(() => {
        throw new Error("connection closed");
      }),
    };
    const channel = createJobEventChannel();
    startProgressPublisher({ nc: nc as never, jobEvents: channel });

    expect(() => channel.open("job-2")).not.toThrow();
  });

  it("stop() stops forwarding further events", () => {
    const nc = fakeNats();
    const channel = createJobEventChannel();
    const stop = startProgressPublisher({
      nc: nc as never,
      jobEvents: channel,
    });

    channel.open("job-3");
    expect(nc.publish).toHaveBeenCalledTimes(1);

    stop();
    channel.close("job-3", { status: "done" });

    expect(nc.publish).toHaveBeenCalledTimes(1);
  });
});

describe("never touches JetStream (#144)", () => {
  it("imports nothing from ./client.js, source", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      fileURLToPath(new URL("./progressPublisher.ts", import.meta.url)),
      "utf-8"
    );
    expect(source).not.toMatch(/client\.js/);
  });
});
