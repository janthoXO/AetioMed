import type { TraceEvent, TracePayload } from "./traceEvent.js";
import { buildTracePayload } from "./tracePayload.js";
import type { EventBus } from "../core/event-bus.js";
import type { JobEventChannel } from "../core/jobEvents/index.js";
import { encodeCase } from "../api/contentWire.js";

export type { TraceEvent, TracePayload };

// The trace channel is an optional producer on the core-owned per-job
// channel, so it declares its own event type there instead of core knowing
// about traces.
declare module "../core/jobEvents/channel.js" {
  interface JobEventMap {
    trace: TraceEvent;
  }
}

/**
 * Forward the graph's bus events onto each job's channel as `trace` events —
 * the node's (capped, English) output for an operator. Called once from the
 * composition root (`app.ts`) when the `TRACING` flag is set.
 *
 * Labels are not produced here any more. They are a product feature, not
 * telemetry, and live in core (`core/jobEvents/labels.ts`, #139).
 *
 * **Issue 15 §1.1 — deliberately not the same channel OTel uses.** This
 * channel is scoped to one job and live-only. OTel (`tracing/otel.ts`, fed
 * from the same `traceNode` seam) is sampled, batched and shipped to a
 * backend for cross-request analysis. Neither imports the other.
 */
export function wireTracing(
  bus: EventBus,
  channel: JobEventChannel,
  maxContentPartBytes: number
): void {
  console.log("[tracing] Initializing tracing...");

  const emit = (jobId: string | undefined, event: TraceEvent) => {
    if (jobId) channel.publish(jobId, "trace", event);
  };

  // `label` is always set in practice — every `traceNode()` call site passes
  // one — but the bus field is optional, so fall back to the node id rather
  // than emit `labelKey: undefined` for a hypothetically label-less node.
  bus.on("Node Started", ({ jobId, node, label, timestamp }) => {
    emit(jobId, {
      kind: "node_started",
      jobId: jobId!,
      nodeId: node,
      labelKey: label ?? node,
      timestamp,
    });
  });

  bus.on("Node Completed", ({ jobId, node, label, result, timestamp }) => {
    emit(jobId, {
      kind: "node_completed",
      jobId: jobId!,
      nodeId: node,
      labelKey: label ?? node,
      timestamp,
      output: buildTracePayload(result),
    });
  });

  bus.on("Node Failed", ({ jobId, node, label, error, timestamp }) => {
    emit(jobId, {
      kind: "node_failed",
      jobId: jobId!,
      nodeId: node,
      labelKey: label ?? node,
      timestamp,
      error,
    });
  });

  bus.on("Generation Completed", ({ jobId, case: generatedCase }) => {
    // SSE serializes this payload to JSON — encode through the same wire
    // codec the rest/nats transports use (issue 11 §5), or a `Uint8Array`
    // content-part value would JSON-stringify to `{"0":...}`.
    emit(jobId, {
      kind: "generation_completed",
      jobId: jobId!,
      timestamp: new Date().toISOString(),
      case: encodeCase(generatedCase, maxContentPartBytes),
    });
  });

  bus.on("Generation Failure", ({ jobId, error }) => {
    const message = error instanceof Error ? error.message : String(error);
    emit(jobId, {
      kind: "generation_failed",
      jobId: jobId!,
      timestamp: new Date().toISOString(),
      error: message,
    });
  });

  bus.on("Generation Cancelled", ({ jobId }) => {
    emit(jobId, {
      kind: "generation_cancelled",
      jobId: jobId!,
      timestamp: new Date().toISOString(),
    });
  });
}
