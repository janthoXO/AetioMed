// Issue 15 §5 — OpenTelemetry as the parallel, operator-facing trace
// channel. See §1's settled decision (documented on `wireTracing` in
// `tracing/index.ts`): this is deliberately NOT the same mechanism as the
// EventBus/SSE channel, and it is gated by its own standard
// `OTEL_SDK_DISABLED`, never by `FEATURES=TRACING` — a deployer can run
// either channel independently of the other.
//
// This module implements the `NodeTracer`/`NodeSpan` port core owns
// (`core/graph/utils/nodeWrapper.ts`) — core never imports `@opentelemetry/*`
// or reads `process.env` (both are off-limits under `src/core/graph/`), so
// the concrete adapter lives here and the composition root (`app.ts`) wires
// it in, exactly the `registerJobHook`/`TraceBus` pattern already used for
// the label/trace channel.
import {
  trace,
  SpanStatusCode,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type { NodeSpan, NodeTracer } from "@/core/graph/utils/nodeWrapper.js";

const TRACER_NAME = "aetiomed";

class OtelNodeSpan implements NodeSpan {
  constructor(private readonly span: Span) {}

  setOutputBytes(bytes: number): void {
    this.span.setAttribute("aetiomed.node.output_bytes", bytes);
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
    this.span.end();
  }
}

class OtelNodeTracer implements NodeTracer {
  constructor(private readonly tracer: Tracer) {}

  startSpan(nodeId: string, attrs: { jobId?: string | undefined }): NodeSpan {
    const span = this.tracer.startSpan(nodeId);
    if (attrs.jobId) span.setAttribute("aetiomed.job_id", attrs.jobId);
    return new OtelNodeSpan(span);
  }
}

let initialized = false;

/**
 * Construct the OTel SDK (provider, resource, OTLP exporter) exactly once,
 * and only when `OTEL_SDK_DISABLED` is not `"true"`.
 *
 * **A guarded dynamic `import()`, not a static one.** "With the SDK
 * disabled, no OTel machinery is constructed" means NOT CONSTRUCTED, not
 * constructed-and-inert (issue 15 §5) — a static `import` of
 * `@opentelemetry/sdk-trace-node` et al. would pull their classes into the
 * module graph and run module-level code regardless of this flag. Only a
 * dynamic import that is never even reached when disabled satisfies that.
 * `otel.test.ts` proves this with `vi.mock` spies on the heavy packages.
 */
async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  initialized = true;

  if (process.env.OTEL_SDK_DISABLED === "true") return;

  const [
    { NodeTracerProvider },
    { BatchSpanProcessor },
    { OTLPTraceExporter },
    { detectResources, envDetector, defaultResource },
  ] = await Promise.all([
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/resources"),
  ]);

  // `envDetector` reads the standard `OTEL_SERVICE_NAME`/
  // `OTEL_RESOURCE_ATTRIBUTES` vars; merging over `defaultResource()` keeps
  // the SDK's own fallback service name for a deployer who sets neither.
  // `OTLPTraceExporter` with no arguments reads
  // `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
  // itself — no plumbing needed here, which is most of what "rely on
  // tracing standards" buys (issue 15 §5). Do not invent our own
  // OTel-ish env vars alongside these three standard ones.
  const resource = defaultResource().merge(
    detectResources({ detectors: [envDetector] })
  );

  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register();
}

/**
 * Build the `NodeTracer` the composition root (`app.ts`) passes to
 * `initGraph`/`buildCaseGraph`. Always called, independent of
 * `FEATURES=TRACING` (§1's settled decision) — with the SDK disabled this
 * still returns a working `NodeTracer`, just one backed by
 * `@opentelemetry/api`'s own global no-op tracer (no provider ever
 * registered), rather than a bespoke no-op of ours: one fewer thing to
 * keep in sync with the real `Span` interface, and exactly what "a no-op
 * tracer otherwise" (issue 15 §5) means.
 *
 * **Open question, deliberately not solved here (issue 15 §5):**
 * checkpointing (F09) can re-execute a node on resume, producing two spans
 * for one logical step under this design (span name = node id, one span
 * per `traceNode` invocation). Whether that should collapse into one span
 * with retries, or stay two linked spans, is left open until F09 lands.
 */
export async function createOtelNodeTracer(): Promise<NodeTracer> {
  await ensureInitialized();
  return new OtelNodeTracer(trace.getTracer(TRACER_NAME));
}
