// Issue 15 §5/§6, extended by #141 — "With the SDK disabled, no OTel
// machinery is constructed" means NOT CONSTRUCTED, not constructed-and-inert.
// Proved here with `vi.mock` spies on the heavy OTel packages (the same
// style `repos.test.ts` uses `fs` spies for "was the heavy thing touched")
// — `otel.ts`'s `ensureInitialized` only reaches these packages via a
// dynamic `import()` gated on {@link selectExporterMode}, so if the
// constructors are never called, the import branch was never taken at all.
//
// #141 adds the logs-signal packages (`sdk-logs`, `exporter-logs-otlp-http`)
// alongside the existing trace ones, and the pure `selectExporterMode`
// table that decides between them without any new env var.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NodeTracerProviderCtor = vi.fn().mockImplementation(function () {
  return { register: vi.fn(), getTracer: vi.fn(), shutdown: vi.fn() };
});
const BatchSpanProcessorCtor = vi.fn();
const SimpleSpanProcessorCtor = vi.fn();
const ConsoleSpanExporterCtor = vi.fn();
const OTLPTraceExporterCtor = vi.fn();

const LoggerProviderCtor = vi.fn().mockImplementation(function () {
  return { getLogger: vi.fn(), shutdown: vi.fn() };
});
const BatchLogRecordProcessorCtor = vi.fn();
const SimpleLogRecordProcessorCtor = vi.fn();
const ConsoleLogRecordExporterCtor = vi.fn();
const OTLPLogExporterCtor = vi.fn();

vi.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: NodeTracerProviderCtor,
}));
vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BatchSpanProcessor: BatchSpanProcessorCtor,
  SimpleSpanProcessor: SimpleSpanProcessorCtor,
  ConsoleSpanExporter: ConsoleSpanExporterCtor,
}));
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: OTLPTraceExporterCtor,
}));
vi.mock("@opentelemetry/sdk-logs", () => ({
  LoggerProvider: LoggerProviderCtor,
  BatchLogRecordProcessor: BatchLogRecordProcessorCtor,
  SimpleLogRecordProcessor: SimpleLogRecordProcessorCtor,
  ConsoleLogRecordExporter: ConsoleLogRecordExporterCtor,
}));
vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: OTLPLogExporterCtor,
}));

const OTEL_VARS = [
  "OTEL_SDK_DISABLED",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
] as const;

const original: Record<string, string | undefined> = {};
for (const key of OTEL_VARS) original[key] = process.env[key];

function resetEnv(): void {
  for (const key of OTEL_VARS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of OTEL_VARS) delete process.env[key];
});

afterEach(() => {
  resetEnv();
});

describe("selectExporterMode (#141) — pure exporter selection table", () => {
  it("OTEL_SDK_DISABLED=true always wins, even with an endpoint set", async () => {
    const { selectExporterMode } = await import("./otel.js");
    expect(
      selectExporterMode(
        {
          OTEL_SDK_DISABLED: "true",
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
        },
        true
      )
    ).toBe("none");
  });

  it('OTEL_SDK_DISABLED="1" is not "true" — does not disable', async () => {
    const { selectExporterMode } = await import("./otel.js");
    expect(selectExporterMode({ OTEL_SDK_DISABLED: "1" }, true)).toBe(
      "console"
    );
    expect(
      selectExporterMode(
        {
          OTEL_SDK_DISABLED: "1",
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
        },
        false
      )
    ).toBe("otlp");
  });

  it.each([
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  ])("%s set selects otlp, regardless of debug", async (key) => {
    const { selectExporterMode } = await import("./otel.js");
    expect(selectExporterMode({ [key]: "http://localhost:4318" }, false)).toBe(
      "otlp"
    );
    expect(selectExporterMode({ [key]: "http://localhost:4318" }, true)).toBe(
      "otlp"
    );
  });

  it("no endpoint + debug selects console", async () => {
    const { selectExporterMode } = await import("./otel.js");
    expect(selectExporterMode({}, true)).toBe("console");
  });

  it("no endpoint, no debug selects none", async () => {
    const { selectExporterMode } = await import("./otel.js");
    expect(selectExporterMode({}, false)).toBe("none");
  });
});

describe("OTel machinery construction (#141)", () => {
  it("disabled (even with an endpoint set): no SDK constructor called, tracer still safe to use", async () => {
    process.env.OTEL_SDK_DISABLED = "true";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    vi.resetModules();
    const { createOtelNodeTracer } = await import("./otel.js");

    const { tracer, shutdown } = await createOtelNodeTracer({ debug: false });
    const span = tracer.startSpan("some_node", { jobId: "job-1" });
    span.setOutput({ hello: "world" });
    span.setLlm("google", "gemini-2.0-flash");
    span.fail("boom");
    span.end();
    await shutdown();

    expect(NodeTracerProviderCtor).not.toHaveBeenCalled();
    expect(BatchSpanProcessorCtor).not.toHaveBeenCalled();
    expect(OTLPTraceExporterCtor).not.toHaveBeenCalled();
    expect(LoggerProviderCtor).not.toHaveBeenCalled();
    expect(BatchLogRecordProcessorCtor).not.toHaveBeenCalled();
    expect(OTLPLogExporterCtor).not.toHaveBeenCalled();
  });

  it("endpoint set: OTLP trace + log exporters and batch processors constructed once, across 3 calls; console ones not", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    vi.resetModules();
    const { createOtelNodeTracer } = await import("./otel.js");

    await createOtelNodeTracer({ debug: false });
    await createOtelNodeTracer({ debug: false });
    await createOtelNodeTracer({ debug: false });

    expect(NodeTracerProviderCtor).toHaveBeenCalledTimes(1);
    expect(BatchSpanProcessorCtor).toHaveBeenCalledTimes(1);
    expect(OTLPTraceExporterCtor).toHaveBeenCalledTimes(1);
    expect(LoggerProviderCtor).toHaveBeenCalledTimes(1);
    expect(BatchLogRecordProcessorCtor).toHaveBeenCalledTimes(1);
    expect(OTLPLogExporterCtor).toHaveBeenCalledTimes(1);

    expect(SimpleSpanProcessorCtor).not.toHaveBeenCalled();
    expect(ConsoleSpanExporterCtor).not.toHaveBeenCalled();
    expect(SimpleLogRecordProcessorCtor).not.toHaveBeenCalled();
    expect(ConsoleLogRecordExporterCtor).not.toHaveBeenCalled();
  });

  it("no endpoint + debug: console exporters + simple processors constructed; OTLP ones not", async () => {
    vi.resetModules();
    const { createOtelNodeTracer } = await import("./otel.js");

    await createOtelNodeTracer({ debug: true });

    expect(NodeTracerProviderCtor).toHaveBeenCalledTimes(1);
    expect(SimpleSpanProcessorCtor).toHaveBeenCalledTimes(1);
    expect(ConsoleSpanExporterCtor).toHaveBeenCalledTimes(1);
    expect(LoggerProviderCtor).toHaveBeenCalledTimes(1);
    expect(SimpleLogRecordProcessorCtor).toHaveBeenCalledTimes(1);
    expect(ConsoleLogRecordExporterCtor).toHaveBeenCalledTimes(1);

    expect(BatchSpanProcessorCtor).not.toHaveBeenCalled();
    expect(OTLPTraceExporterCtor).not.toHaveBeenCalled();
    expect(BatchLogRecordProcessorCtor).not.toHaveBeenCalled();
    expect(OTLPLogExporterCtor).not.toHaveBeenCalled();
  });

  it("no endpoint, no debug: nothing constructed", async () => {
    vi.resetModules();
    const { createOtelNodeTracer } = await import("./otel.js");

    const { tracer } = await createOtelNodeTracer({ debug: false });
    tracer.startSpan("some_node", { jobId: "job-1" }).end();

    expect(NodeTracerProviderCtor).not.toHaveBeenCalled();
    expect(LoggerProviderCtor).not.toHaveBeenCalled();
  });

  it('a value other than the literal "true" is treated as enabled (only the documented value disables it), with an endpoint set', async () => {
    process.env.OTEL_SDK_DISABLED = "1"; // not "true" — must not disable
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    vi.resetModules();
    const { createOtelNodeTracer } = await import("./otel.js");

    await createOtelNodeTracer({ debug: false });

    expect(NodeTracerProviderCtor).toHaveBeenCalledTimes(1);
    expect(LoggerProviderCtor).toHaveBeenCalledTimes(1);
  });
});
