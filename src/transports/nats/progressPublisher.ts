import type { NatsConnection } from "@nats-io/transport-node";
import { JobIdSchema } from "@/api/index.js";
import type { JobEventChannel } from "@/core/jobEvents/index.js";
import { progressSubject } from "./subjects.js";

/**
 * Forward every event on the core-owned per-job channel (#139) onto
 * `cases.progress.<jobId>.<type>` — core NATS, never JetStream (#144).
 *
 * Labels are high-frequency and worthless after the job ends; a stream
 * write per node event for data with a useful life of milliseconds is
 * exactly the overhead #142's stream layout rejects. Publishing to a subject nobody has subscribed to is
 * essentially free on core NATS, so this deliberately does not check for a
 * subscriber first.
 *
 * The subject's last token is the event type (`accepted` | `label` |
 * `complete`) — exactly like the SSE `event:` name on REST — so there is no
 * mapping table between the channel's event names and NATS subjects.
 *
 * Returns a function that stops forwarding.
 */
export function startProgressPublisher(opts: {
  nc: NatsConnection;
  jobEvents: JobEventChannel;
}): () => void {
  const { nc, jobEvents } = opts;
  const warned = new Set<string>();

  return jobEvents.subscribeAll((jobId, event) => {
    // Every jobId that reaches the service is validated against
    // `JobIdSchema`, but a subject built from anything else would address a
    // different subject entirely — same guard as `jobResponders.ts`.
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
      // A closed connection, or any other publish failure, must never break
      // generation — this is a side channel, not the source of truth.
      console.error(
        `[NATS] Failed to publish progress for jobId=${jobId}`,
        error
      );
    }
  });
}
