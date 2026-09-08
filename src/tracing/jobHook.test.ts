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

    runWithContext(() => "ok", "job-set");

    expect(traceManager.getTraceBus("job-set")).toBeDefined();
  });
});
