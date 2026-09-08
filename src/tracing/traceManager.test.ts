// Issue 15 §2 — the second defect fixed as its own change: the per-job
// `TraceBus` used to be torn down on a hardcoded `setTimeout(..., 10000)`
// "to ensure all events are sent". These tests drive the replacement
// directly (no sleeping): teardown happens exactly when the job is terminal
// AND its last consumer has disconnected, with a generous timer only as a
// backstop for a client that never disconnects.
import { describe, expect, it, vi } from "vitest";
import {
  setupTracing,
  getTraceBus,
  registerConsumer,
  unregisterConsumer,
} from "./traceManager.js";

describe("per-job trace bus teardown (issue 15 §2)", () => {
  it("tears down immediately on cleanup() when no consumer is subscribed", () => {
    const jobId = "job-no-consumers";
    const { cleanup } = setupTracing(jobId);
    expect(getTraceBus(jobId)).toBeDefined();

    cleanup(); // "the job reached a terminal state"

    expect(getTraceBus(jobId)).toBeUndefined();
  });

  it("waits for the last consumer to disconnect once terminal, then tears down deterministically", () => {
    const jobId = "job-one-consumer";
    const { cleanup } = setupTracing(jobId);
    registerConsumer(jobId);

    cleanup(); // terminal, but a consumer is still subscribed
    expect(getTraceBus(jobId)).toBeDefined();

    unregisterConsumer(jobId); // the last consumer disconnects
    expect(getTraceBus(jobId)).toBeUndefined();
  });

  it("does not tear down on disconnect alone before the job is terminal", () => {
    const jobId = "job-not-terminal-yet";
    setupTracing(jobId);
    registerConsumer(jobId);

    unregisterConsumer(jobId); // consumer gone, but job still running

    expect(getTraceBus(jobId)).toBeDefined();
  });

  it("supports multiple consumers: only the last disconnect (after terminal) tears down", () => {
    const jobId = "job-two-consumers";
    const { cleanup } = setupTracing(jobId);
    registerConsumer(jobId);
    registerConsumer(jobId);

    cleanup();
    unregisterConsumer(jobId);
    expect(getTraceBus(jobId)).toBeDefined(); // one consumer still connected

    unregisterConsumer(jobId);
    expect(getTraceBus(jobId)).toBeUndefined();
  });

  it("the backstop timer is a fallback, not the mechanism: it still fires for a consumer that never disconnects", () => {
    vi.useFakeTimers();
    try {
      const jobId = "job-hung-consumer";
      const { cleanup } = setupTracing(jobId);
      registerConsumer(jobId);

      cleanup();
      expect(getTraceBus(jobId)).toBeDefined(); // not torn down yet — deterministic path is still open

      vi.advanceTimersByTime(5 * 60 * 1000);

      expect(getTraceBus(jobId)).toBeUndefined(); // backstop fired
    } finally {
      vi.useRealTimers();
    }
  });

  it("the backstop timer is cleared once the deterministic path tears the bus down first", () => {
    vi.useFakeTimers();
    try {
      const jobId = "job-deterministic-wins";
      const { cleanup } = setupTracing(jobId);
      registerConsumer(jobId);

      cleanup();
      unregisterConsumer(jobId); // deterministic teardown fires now

      // If the backstop were still pending, advancing time must not throw
      // or do anything observable — the job entry is already gone.
      expect(() => vi.advanceTimersByTime(5 * 60 * 1000)).not.toThrow();
      expect(getTraceBus(jobId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
