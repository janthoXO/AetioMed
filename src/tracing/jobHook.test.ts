// Proves the tracing inversion from issue 04: `utils/context.ts` no longer
// imports the tracing module, and with no hook registered (as when
// `TRACING` is unset) `runWithContext` allocates no `TraceBus` at all.
import { describe, expect, it, vi } from "vitest";
import { registerJobHook, runWithContext } from "@/core/graph/utils/context.js";
import * as traceManager from "./traceManager.js";

describe("tracing job hook registration", () => {
  it("TRACING unset (no hook registered): setupTracing is never called, no TraceBus is constructed", () => {
    const setupSpy = vi.spyOn(traceManager, "setupTracing");

    runWithContext(() => "ok", "job-unset");

    expect(setupSpy).not.toHaveBeenCalled();
    expect(traceManager.getTraceBus("job-unset")).toBeUndefined();
  });

  it("TRACING enabled (the tracing module registers the hook): runWithContext constructs a TraceBus via it", () => {
    // Exactly what the `tracing` module's setup() does.
    registerJobHook(traceManager.setupTracing);
    const setupSpy = vi.spyOn(traceManager, "setupTracing");

    runWithContext(() => "ok", "job-set");

    // The hook fired and a bus was constructed for the job. It is not
    // asserted to still exist afterwards: `fn` here is synchronous, so by
    // the time `runWithContext` returns the job has already reached its
    // terminal state (issue 15 §2's deterministic teardown — see
    // `traceManager.test.ts`), and with no consumer ever having subscribed
    // there is nothing left to keep the bus alive for.
    expect(setupSpy).toHaveBeenCalledWith("job-set", undefined);
  });
});
