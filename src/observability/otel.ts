// OTel: operator-facing trace channel, independent of end-user labels (`core/jobEvents/`).
// Node output goes out as correlated **log record**, never span attribute. Gated by
// standard `OTEL_SDK_DISABLED`/exporter env vars, not `FEATURES`.
//
// Implements `NodeTracer`/`NodeSpan` port owned by core (`core/graph/utils/nodeWrapper.ts`);
// core never imports `@opentelemetry/*` or reads `process.env`. `app.ts` wires this in.
//
// Only API packages (`@opentelemetry/api`, `api-logs`) imported statically. SDK packages
// only via guarded dynamic `import()` in `ensureInitialized`: disabled = NOT CONSTRUCTED.
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
 * Exporter/processor pair, decided from env only:
 *
 * - `OTEL_SDK_DISABLED === "true"` (only that literal) → `"none"`.
 * - Any OTLP endpoint var set (general or signal-specific) → `"otlp"`.
 * - Else `FEATURES=DEBUG` → `"console"`.
 * - Else → `"none"`.
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
    // No token counts: no LLM call site surfaces `usage_metadata`.
  }

  fail(message: string): void {
    this.span.recordException(message);
    this.span.setStatus({ code: SpanStatusCode.ERROR, message });
  }

  end(): void {
    // Log emitted before span ends, with span as context: correlates by
    // trace_id/span_id. Failed node has no output, so no log; span error says why.
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

/** `NodeTracer` over given `Tracer`/`Logger`. Exported so tests can use in-memory providers. */
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
// Set only in "otlp"/"console" mode. Tracer and logger come from these, not API globals.
let activeTracerProvider:
  | import("@opentelemetry/sdk-trace-base").BasicTracerProvider
  | undefined;
let activeLoggerProvider:
  | import("@opentelemetry/sdk-logs").LoggerProvider
  | undefined;

/**
 * Construct OTel SDK (providers, resource, exporters) once, from {@link selectExporterMode}.
 *
 * Dynamic `import()`, not static: disabled must mean NOT CONSTRUCTED; a static import
 * of SDK packages runs module-level code regardless. `otel.test.ts` proves with `vi.mock` spies.
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

  // `envDetector` reads `OTEL_SERVICE_NAME`/`OTEL_RESOURCE_ATTRIBUTES`; merge over
  // `defaultResource()` keeps SDK fallback service name.
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
    // Exporters with no args read standard `OTEL_EXPORTER_OTLP_*` vars themselves.
    // Do not invent own env vars.
    spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter());
    logProcessor = new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter(),
    });
  } else {
    // "console": zero-infrastructure dev path, no batching delay.
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

  // Not global: nothing else logs through OTel, and a global leaks between tests.
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [logProcessor],
  });

  activeTracerProvider = tracerProvider;
  activeLoggerProvider = loggerProvider;
}

/**
 * Build the `NodeTracer` for `initGraph`/`buildCaseGraph`, plus `shutdown()` that
 * flushes both providers' batched processors.
 *
 * Always called, gated only by {@link selectExporterMode}. Mode `"none"` still
 * returns working tracer/shutdown over `@opentelemetry/api`'s global no-ops.
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
