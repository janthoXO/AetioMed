import {
  getTraceBus,
  getJobLanguage,
  setupTracing,
  registerConsumer,
  unregisterConsumer,
} from "./traceManager.js";
import type { TraceEvent, LabelEvent } from "./traceManager.js";
import { buildTracePayload } from "./tracePayload.js";
import { registerJobHook } from "../core/graph/utils/context.js";
import type { EventBus } from "../core/event-bus.js";
import type { LabelCatalog } from "../core/graph/catalog/ports.js";
import { encodeCase } from "../api/contentWire.js";

export { setupTracing, getTraceBus, registerConsumer, unregisterConsumer };
export type { TraceEvent, LabelEvent };

/**
 * Localize an English trace label into the job's request language, falling
 * back to English — core (`utils/nodeWrapper.ts`) always emits English, this
 * is the one place that translates it for a live consumer (SSE today; see
 * `sse/router.ts`).
 */
function localizeLabel(
  labels: LabelCatalog,
  jobId: string | undefined,
  label: string | undefined
): string | undefined {
  if (!label || !jobId) return label;
  const language = getJobLanguage(jobId);
  if (!language || language === "English") return label;
  return labels.translate(label, language) ?? label;
}

function emitTrace(jobId: string | undefined, event: TraceEvent): void {
  if (!jobId) return;
  const traceBus = getTraceBus(jobId);
  if (!traceBus) return;
  traceBus.emit("trace", event);
}

function emitLabel(jobId: string | undefined, event: LabelEvent): void {
  if (!jobId) return;
  const traceBus = getTraceBus(jobId);
  if (!traceBus) return;
  traceBus.emit("label", event);
}

/**
 * Wire the tracing module into the app: registers the per-job `TraceBus`
 * hook (`registerJobHook`) and forwards the graph's bus events onto each
 * job's `TraceBus`, so a live consumer (SSE — `sse/`) can subscribe
 * per jobId. Called once from the composition root (`app.ts`) when the
 * `TRACING` flag is set.
 *
 * **Issue 15 §1.1 — deliberately not the same channel OTel uses.** This
 * `EventBus`/`TraceBus`/SSE path is the *user-facing* progress channel:
 * scoped to one job, live-only, meant to drive a loading indicator. OTel
 * (`core/graph/utils/otel.ts`, wired from the same `traceNode` seam) is a
 * separate *operator-facing* channel: sampled, batched, and shipped to a
 * backend on its own schedule for cross-request performance analysis.
 * Collapsing the two into one mechanism was flagged as the likely design
 * mistake for this issue — an SSE stream is the wrong shape for
 * cross-request analysis, and a batched OTel export is the wrong shape (and
 * far too slow) for one job's loading indicator. They stay parallel,
 * fed from the same node-execution events, and neither imports the other.
 *
 * **Issue 15 §1.2 — labels are a separate SSE event type from traces, not a
 * `type`-discriminated field on one stream.** Emitted as `event: label`
 * (this module) vs. `event: trace` (`sse/router.ts`), each carrying its own
 * typed shape (`LabelEvent`/`TraceEvent`, `traceManager.ts`): a label is a
 * short, already-localized phrase for the person who submitted the request;
 * a trace is the node's (capped, English) output for an operator. A client
 * rendering a progress indicator should not have to filter operator
 * payloads out of its own event handler, and vice versa.
 */
export function wireTracing(
  bus: EventBus,
  labels: LabelCatalog,
  maxContentPartBytes: number
): void {
  console.log("[tracing] Initializing tracing...");

  registerJobHook(setupTracing);

  bus.on("Node Started", ({ jobId, node, label, timestamp }) => {
    // `label` is always set in practice — every `traceNode()` call site
    // passes one (see `nodeWrapper.ts`'s doc comment) — but the field stays
    // optional on the bus event, so fall back to the node id rather than
    // emitting `labelKey: undefined` for a hypothetically label-less node.
    const labelKey = label ?? node;
    emitTrace(jobId, {
      kind: "node_started",
      jobId: jobId!,
      nodeId: node,
      labelKey,
      timestamp,
    });
    const localized = localizeLabel(labels, jobId, labelKey);
    emitLabel(jobId, {
      jobId: jobId!,
      nodeId: node,
      status: "started",
      label: localized ?? labelKey,
      timestamp,
    });
  });

  bus.on("Node Completed", ({ jobId, node, label, result, timestamp }) => {
    const labelKey = label ?? node;
    emitTrace(jobId, {
      kind: "node_completed",
      jobId: jobId!,
      nodeId: node,
      labelKey,
      timestamp,
      output: buildTracePayload(result),
    });
    const localized = localizeLabel(labels, jobId, labelKey);
    emitLabel(jobId, {
      jobId: jobId!,
      nodeId: node,
      status: "completed",
      label: localized ?? labelKey,
      timestamp,
    });
  });

  bus.on("Node Failed", ({ jobId, node, label, error, timestamp }) => {
    const labelKey = label ?? node;
    emitTrace(jobId, {
      kind: "node_failed",
      jobId: jobId!,
      nodeId: node,
      labelKey,
      timestamp,
      error,
    });
    const localized = localizeLabel(labels, jobId, labelKey);
    emitLabel(jobId, {
      jobId: jobId!,
      nodeId: node,
      status: "failed",
      label: localized ?? labelKey,
      timestamp,
    });
  });

  bus.on("Generation Completed", ({ jobId, case: generatedCase }) => {
    // SSE serializes this payload to JSON (`sse/router.ts`) — encode through
    // the same wire codec the rest/nats transports use (issue 11 §5), or a
    // `Uint8Array` content-part value would JSON-stringify to `{"0":...}`.
    emitTrace(jobId, {
      kind: "generation_completed",
      jobId: jobId!,
      timestamp: new Date().toISOString(),
      case: encodeCase(generatedCase, maxContentPartBytes),
    });
  });

  bus.on("Generation Failure", ({ jobId, error }) => {
    const message = error instanceof Error ? error.message : String(error);
    emitTrace(jobId, {
      kind: "generation_failed",
      jobId: jobId!,
      timestamp: new Date().toISOString(),
      error: message,
    });
  });

  bus.on("Generation Cancelled", ({ jobId }) => {
    emitTrace(jobId, {
      kind: "generation_cancelled",
      jobId: jobId!,
      timestamp: new Date().toISOString(),
    });
  });
}
