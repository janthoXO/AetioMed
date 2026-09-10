import type { EventBus } from "../event-bus.js";
import type { LabelCatalog } from "../graph/catalog/ports.js";
import type { Language } from "../graph/models/Language.js";
import type { JobEventChannel } from "./channel.js";

/**
 * The end-user progress event: one short, already-localized phrase per node
 * execution, keyed by the same `nodeId` `GET /api/graph` reports. `status`
 * lets a progress UI pick an icon (spinner / check / error) without
 * inspecting anything else.
 *
 * It never carries node output. That is what makes it safe to have no size
 * cap and no English-only rule: it is always small, and it is meant for the
 * person who submitted the request.
 */
export type LabelEvent = {
  jobId: string;
  nodeId: string;
  status: "started" | "completed" | "failed";
  /** Localized, falling back to English — see {@link localizeLabel}. */
  label: string;
  timestamp: string;
};

/**
 * Localize an English label key into the job's request language, falling
 * back to English. Core (`utils/nodeWrapper.ts`) always emits English; this
 * is the one place that translates it. A missing translation is never fatal.
 */
export function localizeLabel(
  labels: LabelCatalog,
  labelKey: string,
  language: Language | undefined
): string {
  if (!language || language === "English") return labelKey;
  return labels.translate(labelKey, language) ?? labelKey;
}

/**
 * Turn the graph's node lifecycle events into localized label events on the
 * job's channel. Called once by the composition root (`app.ts`).
 *
 * Labels carry `started` **and** a terminal status. "The next start implies
 * the previous node finished" is false for this graph: `Send` fans nodes out
 * in parallel, and the blinded-solver loop revisits nodes (#140).
 */
export function wireLabels(
  bus: EventBus,
  channel: JobEventChannel,
  labels: LabelCatalog
): void {
  const forward =
    (status: LabelEvent["status"]) =>
    (e: {
      node: string;
      label?: string;
      jobId?: string;
      language?: Language;
      timestamp: string;
    }) => {
      if (!e.jobId) return;
      // Every `traceNode()` call site passes a label, but the bus field is
      // optional. Fall back to the node id rather than publish no label.
      const labelKey = e.label ?? e.node;
      channel.publish(e.jobId, "label", {
        jobId: e.jobId,
        nodeId: e.node,
        status,
        label: localizeLabel(labels, labelKey, e.language),
        timestamp: e.timestamp,
      });
    };

  bus.on("Node Started", forward("started"));
  bus.on("Node Completed", forward("completed"));
  bus.on("Node Failed", forward("failed"));
}
