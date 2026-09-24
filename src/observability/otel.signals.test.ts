// Real OTel SDK, no mocks: in-memory span and log exporters. Proves what mocked
// `otel.test.ts` cannot: log correlates to span by trace_id/span_id, no span
// attribute carries output text, truncation marker reaches log body.
import { describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
  InMemoryLogRecordExporter,
} from "@opentelemetry/sdk-logs";
import { SpanStatusCode } from "@opentelemetry/api";
import { createNodeTracer } from "./otel.js";
import { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { EventBus } from "@/core/event-bus.js";
import { runWithContext } from "@/core/graph/utils/context.js";
import { encodeText } from "@/core/graph/models/ContentPart.js";

function setup() {
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });

  const logExporter = new InMemoryLogRecordExporter();
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
  });

  const tracer = tracerProvider.getTracer("test");
  const logger = loggerProvider.getLogger("test");
  const nodeTracer = createNodeTracer(tracer, logger);

  return { spanExporter, logExporter, nodeTracer };
}

describe("OTel signals end to end — real SDK, no mocks", () => {
  it("a node's output is a correlated log record, never a span attribute", async () => {
    const { spanExporter, logExporter, nodeTracer } = setup();
    const bus = new EventBus();
    const traceNode = createTraceNode(bus, nodeTracer);
    const secret = "SECRET-OUTPUT " + "x".repeat(2000);
    const wrapped = traceNode(
      "outline_generate",
      async () => ({ outline: secret }),
      "Generating the outline"
    );

    await runWithContext(() => wrapped(), "job-otel");

    const spans = spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe("outline_generate");
    expect(span.attributes["aetiomed.node.id"]).toBe("outline_generate");
    expect(span.attributes["aetiomed.job_id"]).toBe("job-otel");
    expect(span.attributes["aetiomed.node.output_bytes"]).toBeTypeOf("number");
    expect(
      span.attributes["aetiomed.node.output_bytes"] as number
    ).toBeGreaterThan(2000);

    for (const value of Object.values(span.attributes)) {
      expect(String(value)).not.toContain("SECRET-OUTPUT");
    }

    const logs = logExporter.getFinishedLogRecords();
    expect(logs).toHaveLength(1);
    const log = logs[0]!;
    expect(String(log.body)).toContain("SECRET-OUTPUT");
    expect(log.spanContext?.traceId).toBe(span.spanContext().traceId);
    expect(log.spanContext?.spanId).toBe(span.spanContext().spanId);
  });

  it("a ContentPart's bytes never reach the log body, only its decoded/alt text", async () => {
    const { logExporter, nodeTracer } = setup();
    const bus = new EventBus();
    const traceNode = createTraceNode(bus, nodeTracer);
    const wrapped = traceNode(
      "chief_complaint_generate",
      async () => ({
        chiefComplaint: [
          { type: "text/plain", value: encodeText("hello"), alt: "hello" },
        ],
      }),
      "Generating chief complaint"
    );

    await wrapped();

    const logs = logExporter.getFinishedLogRecords();
    expect(logs).toHaveLength(1);
    const body = String(logs[0]!.body);
    expect(body).toContain("hello");
    expect(body).not.toContain('"0":');
  });

  it("an output over the 50 KB cap becomes a truncated marker in both the log body and its attribute", async () => {
    const { logExporter, nodeTracer } = setup();
    const bus = new EventBus();
    const traceNode = createTraceNode(bus, nodeTracer);
    const wrapped = traceNode(
      "big_node",
      async () => ({ blob: "y".repeat(60_000) }),
      "A big node"
    );

    await wrapped();

    const logs = logExporter.getFinishedLogRecords();
    expect(logs).toHaveLength(1);
    const log = logs[0]!;
    expect(log.attributes["aetiomed.node.output_truncated"]).toBe(true);

    const parsed = JSON.parse(String(log.body)) as {
      truncated: boolean;
      bytes: number;
      preview: string;
    };
    expect(parsed.truncated).toBe(true);
    expect(parsed.bytes).toBeGreaterThan(50_000);
    expect(typeof parsed.preview).toBe("string");
  });

  it("a throwing node ends its span with ERROR status and emits no log record; the error still propagates", async () => {
    const { spanExporter, logExporter, nodeTracer } = setup();
    const bus = new EventBus();
    const traceNode = createTraceNode(bus, nodeTracer);
    const wrapped = traceNode(
      "failing_node",
      async () => {
        throw new Error("boom");
      },
      "A failing node"
    );

    await expect(wrapped()).rejects.toThrow("boom");

    const spans = spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);

    expect(logExporter.getFinishedLogRecords()).toHaveLength(0);
  });

  it("a scoped nodeId reports the qualified path as both span name and aetiomed.node.id", async () => {
    const { spanExporter, nodeTracer } = setup();
    const bus = new EventBus();
    const traceNode = createTraceNode(bus, nodeTracer).scope("phase");
    const wrapped = traceNode("inner", async () => "value", "Inner node");

    await wrapped();

    const spans = spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("phase:inner");
    expect(spans[0]!.attributes["aetiomed.node.id"]).toBe("phase:inner");
  });
});
