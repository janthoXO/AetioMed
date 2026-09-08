// Issue 15 §5/§6 — "With the SDK disabled, no OTel machinery is
// constructed" means NOT CONSTRUCTED, not constructed-and-inert. Proved
// here with `vi.mock` spies on the heavy OTel packages (the same style
// `repos.test.ts` uses `fs` spies for "was the heavy thing touched") —
// `otel.ts`'s `ensureInitialized` only reaches these packages via a
// dynamic `import()` gated on `OTEL_SDK_DISABLED`, so if the constructors
// are never called, the import branch was never taken at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NodeTracerProviderCtor = vi.fn().mockImplementation(function () {
  return { register: vi.fn() };
});
const BatchSpanProcessorCtor = vi.fn();
const OTLPTraceExporterCtor = vi.fn();

vi.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: NodeTracerProviderCtor,
}));
vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BatchSpanProcessor: BatchSpanProcessorCtor,
}));
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: OTLPTraceExporterCtor,
}));

const ORIGINAL_OTEL_SDK_DISABLED = process.env.OTEL_SDK_DISABLED;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (ORIGINAL_OTEL_SDK_DISABLED === undefined) {
    delete process.env.OTEL_SDK_DISABLED;
  } else {
    process.env.OTEL_SDK_DISABLED = ORIGINAL_OTEL_SDK_DISABLED;
  }
});

describe("OTel machinery construction gated by OTEL_SDK_DISABLED (issue 15 §5)", () => {
  it("disabled: no OTel machinery is constructed, and startSpan is still safe to call", async () => {
    process.env.OTEL_SDK_DISABLED = "true";
    vi.resetModules();
    const { createOtelNodeTracer } = await import("./otel.js");

    const tracer = await createOtelNodeTracer();
    const span = tracer.startSpan("some_node", { jobId: "job-1" });
    span.setOutputBytes(10);
    span.setLlm("google", "gemini-2.0-flash");
    span.fail("boom");
    span.end();

    expect(NodeTracerProviderCtor).not.toHaveBeenCalled();
    expect(BatchSpanProcessorCtor).not.toHaveBeenCalled();
    expect(OTLPTraceExporterCtor).not.toHaveBeenCalled();
  });

  it("enabled: the provider, span processor and exporter are constructed exactly once, even across repeated calls", async () => {
    delete process.env.OTEL_SDK_DISABLED;
    vi.resetModules();
    const { createOtelNodeTracer } = await import("./otel.js");

    await createOtelNodeTracer();
    await createOtelNodeTracer();
    await createOtelNodeTracer();

    expect(NodeTracerProviderCtor).toHaveBeenCalledTimes(1);
    expect(BatchSpanProcessorCtor).toHaveBeenCalledTimes(1);
    expect(OTLPTraceExporterCtor).toHaveBeenCalledTimes(1);
  });

  it('a value other than the literal "true" is treated as enabled (only the documented value disables it)', async () => {
    process.env.OTEL_SDK_DISABLED = "1"; // not "true" — must not disable
    vi.resetModules();
    const { createOtelNodeTracer } = await import("./otel.js");

    await createOtelNodeTracer();

    expect(NodeTracerProviderCtor).toHaveBeenCalledTimes(1);
  });
});
