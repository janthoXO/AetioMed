import type { NatsConnection } from "@nats-io/transport-node";
import { JobIdSchema } from "@/api/index.js";
import type { JobEventChannel } from "@/core/jobEvents/index.js";
import { progressSubject } from "./subjects.js";

/**
 * Forward every per-job channel event to `cases.progress.<jobId>.<type>`.
 * Core NATS, not JetStream: labels are high-frequency and worthless after
 * job ends. Publishing with no subscriber is ~free, so no subscriber check.
 *
 * Last subject token = event type (`accepted` | `label` | `complete`), same
 * as SSE `event:` name; no mapping table.
 *
 * Returns stop function.
 */
export function startProgressPublisher(opts: {
  nc: NatsConnection;
  jobEvents: JobEventChannel;
}): () => void {
  const { nc, jobEvents } = opts;
  const warned = new Set<string>();

  return jobEvents.subscribeAll((jobId, event) => {
    // Non-token jobId would address a different subject; same guard as `jobResponders.ts`.
    if (!JobIdSchema.safeParse(jobId).success) {
      if (!warned.has(jobId)) {
        warned.add(jobId);
        console.warn(
          `[NATS] jobId=${jobId} is not a subject token; progress not published over NATS`
        );
      }
      return;
    }

    try {
      nc.publish(
        progressSubject(jobId, event.type),
        JSON.stringify(event.data)
      );
    } catch (error) {
      // Side channel: publish failure must never break generation.
      console.error(
        `[NATS] Failed to publish progress for jobId=${jobId}`,
        error
      );
    }
  });
}
