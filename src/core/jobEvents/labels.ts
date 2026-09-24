import type { EventBus } from "../event-bus.js";
import type { LabelCatalog } from "../graph/catalog/ports.js";
import type { Language } from "../graph/models/Language.js";
import type { JobEventChannel } from "./channel.js";

/**
 * End-user progress event: one short localized phrase per node execution,
 * keyed by `nodeId` as in `GET /api/graph`. Never carries node output.
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
 * Localize English label key to request language; falls back to English.
 * Core emits English; only place that translates.
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
 * Turn node lifecycle bus events into localized label events on the job's
 * channel. Emits `started` **and** terminal status: next start does not imply
 * previous finished (`Send` parallel fan-out, solver loop revisits nodes).
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
      // Bus `label` optional; fall back to node id.
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
