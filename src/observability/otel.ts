// Issue #141 (formerly issue 15 §5) — OpenTelemetry as the parallel,
// operator-facing trace channel. This is deliberately NOT the same
// mechanism as the end-user labels channel (`core/jobEvents/`, #139/#140):
// labels carry a localized phrase and no payload and are always on; OTel
// carries node output — as a correlated **log record**, never a span
// attribute (docs/issues/17-transport-parity.md §"Why the node output is a
// log record") — and is gated by its own standard `OTEL_SDK_DISABLED`/
// exporter env vars, never by a `FEATURES` flag — a deployer can run either
// channel independently of the other.
//
// This module implements the `NodeTracer`/`NodeSpan` port core owns
// (`core/graph/utils/nodeWrapper.ts`) — core never imports `@opentelemetry/*`
// or reads `process.env` (both are off-limits under `src/core/graph/`), so
// the concrete adapter lives here and the composition root (`app.ts`) wires
// it in, the same core-owns-the-port/adapter-lives-outside pattern used for
// the labels channel (`core/jobEvents/`).
//
// Only the API packages (`@opentelemetry/api`, `@opentelemetry/api-logs`)
// are statically imported — they are pure interfaces/no-op globals, not
// machinery. Every SDK package (`sdk-trace-node`, `sdk-trace-base`,
// `sdk-logs`, the two OTLP exporters, `resources`) is reached only through a
// guarded dynamic `import()` in `ensureInitialized`, so "SDK disabled" means
// NOT CONSTRUCTED, not constructed-and-inert.
import {
  trace,
  context as otelContext,
  SpanStatusCode,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import {
  logs,
  SeverityNumber,
  type Logger,
  type LogAttributes,
} from "@opentelemetry/api-logs";
import type { NodeSpan, NodeTracer } from "@/core/graph/utils/nodeWrapper.js";
import { buildTracePayload } from "./tracePayload.js";

const TRACER_NAME = "aetiomed";
const LOGGER_NAME = "aetiomed";

/**
 * Which exporter/processor pair to build, decided purely from env — no new
 * flag (issue #141 / docs/issues/17-transport-parity.md §"Exporter
 * selection"):
 *
 * - `OTEL_SDK_DISABLED === "true"` (only that literal) → `"none"`.
 * - Any OTLP endpoint var set (general or signal-specific) → `"otlp"`.
 * - Otherwise, `FEATURES=DEBUG` → `"console"`.
 * - Otherwise → `"none"` — a **behaviour change** from before this issue:
 *   an unset endpoint used to still build a real SDK exporting to
 *   `localhost:4318` and failing silently in the background. Now nothing is
 *   constructed unless there is somewhere to send spans/logs, or the
 *   deployer explicitly asked for the zero-infrastructure console path via
 *   `FEATURES=DEBUG`.
 */
export type ExporterMode = "otlp" | "console" | "none";

export function selectExporterMode(
  env: NodeJS.ProcessEnv,
  debug: boolean
): ExporterMode {
  if (env.OTEL_SDK_DISABLED === "true") return "none";

  const hasOtlpEndpoint = [
    env.OTEL_EXPORTER_OTLP_ENDPOINT,
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
  ].some((v) => v !== undefined && v !== "");
  if (hasOtlpEndpoint) return "otlp";

  if (debug) return "console";

  return "none";
}

class OtelNodeSpan implements NodeSpan {
  private output: unknown;
  private outputSet = false;
  private outputBytes = 0;

  constructor(
    private readonly span: Span,
    private readonly logger: Logger,
    private readonly nodeId: string,
    private readonly jobId: string | undefined
  ) {}

  setOutput(output: unknown): void {
    this.output = output;
    this.outputSet = true;
    this.outputBytes = byteSizeOf(output);
    this.span.setAttribute("aetiomed.node.output_bytes", this.outputBytes);
  }

  setLlm(provider: string, model: string): void {
    this.span.setAttribute("aetiomed.llm.provider", provider);
    this.span.setAttribute("aetiomed.llm.model", model);
    // Token counts: verified against this codebase — no call site records
    // `usage_metadata`/token counts from any LLM response today, so "where
    // available" (issue 15 §5) currently means "never". No attribute is
    // fabricated here; wiring real counts through would mean the
    // aigateway layer surfacing them, which is out of scope for this issue.
  }

  fail(message: string): void {
    this.span.recordException(message);
    this.span.setStatus({ code: SpanStatusCode.ERROR, message });
  }

  end(): void {
    // The log record is emitted before the span ends, with this span as its
    // context (`trace.setSpan`): that is what correlates the two by
    // trace_id/span_id. A failed node never had an output set, so it gets
    // no log record — its span's error status says what happened.
    if (this.outputSet) {
      const payload = buildTracePayload(this.output);
      const attributes: LogAttributes = {
        "event.name": "aetiomed.node.output",
        "aetiomed.node.id": this.nodeId,
        "aetiomed.node.output_bytes": this.outputBytes,
        "aetiomed.node.output_truncated": payload.truncated,
      };
      if (this.jobId) attributes["aetiomed.job_id"] = this.jobId;

      const body = payload.truncated
        ? JSON.stringify({
            truncated: true,
            bytes: payload.bytes,
            preview: payload.preview,
          })
        : JSON.stringify(payload.value);

      this.logger.emit({
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
        attributes,
        body,
        context: trace.setSpan(otelContext.active(), this.span),
      });
    }

    this.span.end();
  }
}

/** Best-effort JSON byte size — never throws. */
function byteSizeOf(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return 0;
  }
}

/**
 * Build the `NodeTracer` port over an already-constructed `Tracer`/`Logger`
 * pair. Exported so tests can wire it over in-memory providers
 * (`otel.signals.test.ts`) without going through `ensureInitialized`'s env
 * gating at all.
 */
export function createNodeTracer(tracer: Tracer, logger: Logger): NodeTracer {
  return {
    startSpan(nodeId: string, attrs: { jobId?: string | undefined }): NodeSpan {
      const span = tracer.startSpan(nodeId);
      span.setAttribute("aetiomed.node.id", nodeId);
      if (attrs.jobId) span.setAttribute("aetiomed.job_id", attrs.jobId);
      return new OtelNodeSpan(span, logger, nodeId, attrs.jobId);
    },
  };
}

let initialized = false;
// Set only in "otlp"/"console" mode, by `ensureInitialized`. The tracer and
// logger come from these providers, not from the API's globals.
let activeTracerProvider:
  | import("@opentelemetry/sdk-trace-base").BasicTracerProvider
  | undefined;
let activeLoggerProvider:
  | import("@opentelemetry/sdk-logs").LoggerProvider
  | undefined;

/**
 * Construct the OTel SDK (tracer provider + logger provider, resource,
 * exporters) exactly once, from {@link selectExporterMode}.
 *
 * **A guarded dynamic `import()`, not a static one.** "With the SDK
 * disabled, no OTel machinery is constructed" means NOT CONSTRUCTED, not
 * constructed-and-inert (issue 15 §5) — a static `import` of
 * `@opentelemetry/sdk-trace-node` et al. would pull their classes into the
 * module graph and run module-level code regardless of this flag. Only a
 * dynamic import that is never even reached when disabled satisfies that.
 * `otel.test.ts` proves this with `vi.mock` spies on the heavy packages.
 */
async function ensureInitialized(mode: ExporterMode): Promise<void> {
  if (initialized) return;
  initialized = true;

  console.log(`[otel] exporter: ${mode}`);

  if (mode === "none") return;

  const [
    { NodeTracerProvider },
    { BatchSpanProcessor, SimpleSpanProcessor, ConsoleSpanExporter },
    { detectResources, envDetector, defaultResource },
    {
      LoggerProvider,
      BatchLogRecordProcessor,
      SimpleLogRecordProcessor,
      ConsoleLogRecordExporter,
    },
  ] = await Promise.all([
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/sdk-logs"),
  ]);

  // `envDetector` reads the standard `OTEL_SERVICE_NAME`/
  // `OTEL_RESOURCE_ATTRIBUTES` vars; merging over `defaultResource()` keeps
  // the SDK's own fallback service name for a deployer who sets neither.
  const resource = defaultResource().merge(
    detectResources({ detectors: [envDetector] })
  );

  let spanProcessor: import("@opentelemetry/sdk-trace-base").SpanProcessor;
  let logProcessor: import("@opentelemetry/sdk-logs").LogRecordProcessor;

  if (mode === "otlp") {
    const [{ OTLPTraceExporter }, { OTLPLogExporter }] = await Promise.all([
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/exporter-logs-otlp-http"),
    ]);
    // `OTLPTraceExporter`/`OTLPLogExporter` with no arguments read the
    // standard `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`/
    // `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` themselves — no plumbing needed
    // here. Do not invent our own OTel-ish env vars alongside these.
    spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter());
    logProcessor = new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter(),
    });
  } else {
    // "console" — the zero-infrastructure development path (see
    // docs/issues/17-transport-parity.md §"Exporters and processors").
    spanProcessor = new SimpleSpanProcessor(new ConsoleSpanExporter());
    logProcessor = new SimpleLogRecordProcessor({
      exporter: new ConsoleLogRecordExporter(),
    });
  }

  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [spanProcessor],
  });
  tracerProvider.register();

  // Not registered as the global logger provider: nothing else in the
  // process logs through OTel, and a global would leak between tests.
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [logProcessor],
  });

  activeTracerProvider = tracerProvider;
  activeLoggerProvider = loggerProvider;
}

/**
 * Build the `NodeTracer` the composition root (`app.ts`) passes to
 * `initGraph`/`buildCaseGraph`, plus a `shutdown()` closer that flushes both
 * providers' batched processors — registered by `app.ts` after NATS and
 * before the DB, so telemetry is flushed once producers have stopped but
 * before the process exits.
 *
 * Always called, gated only by {@link selectExporterMode}. With mode
 * `"none"` this still returns a working `NodeTracer`/`shutdown`, just one
 * backed by `@opentelemetry/api`'s and `@opentelemetry/api-logs`'s own
 * global no-op tracer/logger (no provider ever registered), rather than a
 * bespoke no-op of ours: one fewer thing to keep in sync with the real
 * `Span`/`Logger` interfaces.
 *
 * **Open question, deliberately not solved here (issue 15 §5):**
 * checkpointing (F09) can re-execute a node on resume, producing two spans
 * for one logical step under this design (span name = node id, one span
 * per `traceNode` invocation). Whether that should collapse into one span
 * with retries, or stay two linked spans, is left open until F09 lands.
 */
export async function createOtelNodeTracer(opts: {
  debug: boolean;
}): Promise<{ tracer: NodeTracer; shutdown: () => Promise<void> }> {
  const mode = selectExporterMode(process.env, opts.debug);
  await ensureInitialized(mode);

  const tracer = activeTracerProvider
    ? activeTracerProvider.getTracer(TRACER_NAME)
    : trace.getTracer(TRACER_NAME);
  const logger = activeLoggerProvider
    ? activeLoggerProvider.getLogger(LOGGER_NAME)
    : logs.getLogger(LOGGER_NAME);

  // Flushes both providers' batched processors.
  const shutdown = async (): Promise<void> => {
    await Promise.all([
      activeTracerProvider?.shutdown(),
      activeLoggerProvider?.shutdown(),
    ]);
  };

  return { tracer: createNodeTracer(tracer, logger), shutdown };
}
