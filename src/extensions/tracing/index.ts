import { getTraceBus, getJobLanguage, setupTracing } from "./traceManager.js";
import type { TraceEvent } from "./traceManager.js";
import { registerJobHook } from "../../core/graph/utils/context.js";
import type { EventBus } from "../../core/event-bus.js";
import type { LabelCatalog } from "../../core/graph/catalog/ports.js";

export { setupTracing, getTraceBus };
export type { TraceEvent };

/**
 * Localize an English trace label into the job's request language, falling
 * back to English — core (`utils/nodeWrapper.ts`) always emits English, this
 * is the one place that translates it for a live consumer (SSE today; see
 * `tracingRest/router.ts`).
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

function emitToTraceBus(
  jobId: string | undefined,
  type: string,
  payload: unknown
) {
  if (!jobId) return;
  const traceBus = getTraceBus(jobId);
  if (!traceBus) return;
  const event: TraceEvent = {
    jobId,
    type,
    timestamp: new Date().toISOString(),
    payload,
  };
  traceBus.emit("trace", event);
}

/**
 * Wire the tracing module into the app: registers the per-job `TraceBus`
 * hook (`registerJobHook`) and forwards the graph's bus events onto each
 * job's `TraceBus`, so a live consumer (SSE — `tracingRest`) can subscribe
 * per jobId. Called once from the composition root (`app.ts`) when the
 * `TRACING` flag is set.
 */
export function wireTracing(bus: EventBus, labels: LabelCatalog): void {
  console.log("[tracing] Initializing tracing...");

  registerJobHook(setupTracing);

  bus.on("Node Started", ({ jobId, node, label, timestamp }) => {
    emitToTraceBus(jobId, "Node Started", {
      node,
      label: localizeLabel(labels, jobId, label),
      timestamp,
    });
  });

  bus.on("Node Completed", ({ jobId, node, label, result, timestamp }) => {
    emitToTraceBus(jobId, "Node Completed", {
      node,
      label: localizeLabel(labels, jobId, label),
      result,
      timestamp,
    });
  });

  bus.on("Generation Completed", ({ jobId, case: generatedCase }) => {
    emitToTraceBus(jobId, "Generation Completed", { case: generatedCase });
  });

  bus.on("Generation Failure", ({ jobId, error }) => {
    const message = error instanceof Error ? error.message : String(error);
    emitToTraceBus(jobId, "Generation Failure", { message });
  });

  bus.on("Generation Cancelled", ({ jobId }) => {
    emitToTraceBus(jobId, "Generation Cancelled", {});
  });
}
