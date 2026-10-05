import {
  NoRespondersError,
  RequestError,
  type NatsConnection,
  type Subscription,
} from "@nats-io/transport-node";
import {
  createBufferedWatch,
  type CancelResult,
  type JobDirectory,
  type WatchResult,
  type WatchedEvent,
} from "@/core/jobEvents/index.js";
import type { JobStatusReply } from "./jobResponders.js";
import { cancelSubject, progressWildcard, statusSubject } from "./subjects.js";

/** How long to wait for the owning replica to answer a status/cancel request. */
export const DIRECTORY_REQUEST_TIMEOUT_MS = 2_000;

function isNoResponders(error: unknown): boolean {
  return (
    (error instanceof RequestError && error.isNoResponders()) ||
    error instanceof NoRespondersError
  );
}

/**
 * Multi-replica job directory: asks the owning replica over subjects
 * `jobResponders.ts` answers. "No responders" = no replica has job = unknown.
 */
export function createNatsJobDirectory(nc: NatsConnection): JobDirectory {
  return {
    async watch(jobId): Promise<WatchResult> {
      // Subscribe before asking state: a job finishing in between still
      // delivers `complete` here. Buffered until caller listens.
      const subscription: Subscription = nc.subscribe(progressWildcard(jobId));
      const buffered = createBufferedWatch(() => subscription.unsubscribe());
      (async () => {
        for await (const msg of subscription) {
          const type = msg.subject.split(".").pop();
          if (type !== "label" && type !== "complete") continue;
          buffered.push({ type, data: msg.json() } as WatchedEvent);
          if (type === "complete") subscription.unsubscribe();
        }
      })().catch(() => undefined);

      let reply: JobStatusReply;
      try {
        const msg = await nc.request(statusSubject(jobId), "", {
          timeout: DIRECTORY_REQUEST_TIMEOUT_MS,
        });
        reply = msg.json<JobStatusReply>();
      } catch (error) {
        subscription.unsubscribe();
        if (isNoResponders(error)) return { state: "unknown" };
        throw error;
      }

      if (reply.state === "active") return buffered.watch;
      subscription.unsubscribe();
      return reply;
    },

    async cancel(jobId): Promise<CancelResult> {
      try {
        const msg = await nc.request(cancelSubject(jobId), "", {
          timeout: DIRECTORY_REQUEST_TIMEOUT_MS,
        });
        return msg.json<{ cancelled: boolean }>().cancelled
          ? "cancelled"
          : "finished";
      } catch (error) {
        if (isNoResponders(error)) return "unknown";
        throw error;
      }
    },
  };
}
