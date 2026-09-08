// Issue 18: one ordered, bounded shutdown owned by the composition root.
// These tests drive `runClosers`/`installSignalHandlers` directly rather
// than sending real OS signals — `installSignalHandlers` returns its
// internal handler for exactly this reason, and every deadline case uses
// fake timers instead of sleeping.
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSignalHandlers, runClosers, type Closer } from "./shutdown.js";

describe("runClosers", () => {
  it("runs closers in the declared order", async () => {
    const calls: string[] = [];
    const closers: Closer[] = [
      { name: "REST", close: async () => void calls.push("REST") },
      { name: "NATS", close: async () => void calls.push("NATS") },
      { name: "DB", close: async () => void calls.push("DB") },
    ];

    await runClosers(closers);

    expect(calls).toEqual(["REST", "NATS", "DB"]);
  });

  it("still attempts later closers after an earlier one rejects, and surfaces the failure", async () => {
    const calls: string[] = [];
    const closers: Closer[] = [
      {
        name: "REST",
        close: async () => {
          calls.push("REST");
          throw new Error("REST close failed");
        },
      },
      { name: "NATS", close: async () => void calls.push("NATS") },
      { name: "DB", close: async () => void calls.push("DB") },
    ];

    // A failing closer must not strand the ones after it — the DB has to
    // close even when REST or NATS blew up on the way there.
    await expect(runClosers(closers)).rejects.toThrow(/REST/);
    expect(calls).toEqual(["REST", "NATS", "DB"]);
  });
});

describe("installSignalHandlers", () => {
  let installed: ((signal: NodeJS.Signals) => void) | undefined;

  afterEach(() => {
    if (installed) {
      process.removeListener("SIGINT", installed);
      process.removeListener("SIGTERM", installed);
      installed = undefined;
    }
    vi.useRealTimers();
  });

  it("runs shutdown() then exits 0 on the first signal", async () => {
    const exit = vi.fn();
    const shutdown = vi.fn(async () => {});

    installed = installSignalHandlers(shutdown, { exit });
    installed("SIGINT");

    // Let the shutdown() promise chain settle.
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("exits 1 if shutdown() rejects", async () => {
    const exit = vi.fn();
    const shutdown = vi.fn(async () => {
      throw new Error("boom");
    });

    installed = installSignalHandlers(shutdown, { exit });
    installed("SIGTERM");

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it("exits 1 via the deadline when shutdown() never resolves", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const shutdown = vi.fn(() => new Promise<void>(() => {})); // never settles

    installed = installSignalHandlers(shutdown, { exit });
    installed("SIGINT");

    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("a second signal exits 130 immediately, without waiting for the first shutdown()", async () => {
    const exit = vi.fn();
    // Never resolves: proves the second-signal path doesn't wait on it.
    const shutdown = vi.fn(() => new Promise<void>(() => {}));

    installed = installSignalHandlers(shutdown, { exit });
    installed("SIGINT");
    installed("SIGINT");

    expect(exit).toHaveBeenCalledWith(130);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1); // only the first signal ran it
  });
});
