import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import { JobIdSchema } from "@/api/index.js";
import type { CaseGenerationService } from "@/core/caseGenerationService.js";
import {
  TOMBSTONE_MS,
  type JobEventChannel,
  type JobPeek,
} from "@/core/jobEvents/index.js";
import { cancelSubject, statusSubject } from "./subjects.js";

/** What `cases.status.<jobId>` answers — never `unknown`: nobody answers then. */
export type JobStatusReply = Exclude<JobPeek, { state: "unknown" }>;

/**
 * Answer per-job requests for every job this process runs, any transport.
 * Ownership = subscription interest: subscribe on accept, so requests reach
 * only the owner; unknown job gets "no responders".
 *
 * - `cases.cancel.<jobId>` → `{cancelled}` while job runs. `false` only if
 *   job finished between request and abort.
 * - `cases.status.<jobId>` → `{state: "active"}` while running, then
 *   `{state: "terminal", complete}` for tombstone window. A `planned` job
 *   stops answering at once: continuation may run on any replica.
 *
 * Returns stop function.
 */
export function startJobResponders(opts: {
  nc: NatsConnection;
  jobEvents: JobEventChannel;
  service: CaseGenerationService;
}): () => void {
  const { nc, jobEvents, service } = opts;
  const cancels = new Map<string, Subscription>();
  const statuses = new Map<
    string,
    { subscription: Subscription; expire?: ReturnType<typeof setTimeout> }
  >();

  const stopStatus = (jobId: string) => {
    const entry = statuses.get(jobId);
    if (!entry) return;
    clearTimeout(entry.expire);
    entry.subscription.unsubscribe();
    statuses.delete(jobId);
  };

  const stopListening = jobEvents.subscribeAll((jobId, event) => {
    if (event.type === "accepted") {
      // Guard: non-token jobId would address a different subject.
      if (!JobIdSchema.safeParse(jobId).success) {
        console.warn(
          `[NATS] jobId=${jobId} is not a subject token; not reachable over NATS`
        );
        return;
      }
      stopStatus(jobId); // a reused id after its tombstone expired
      cancels.set(
        jobId,
        nc.subscribe(cancelSubject(jobId), {
          callback: (error, msg) => {
            if (error) return;
            const cancelled = service.cancel(jobId);
            console.log(
              `[NATS] Cancel for jobId=${jobId}: ${cancelled ? "aborted" : "already finished"}`
            );
            msg.respond(JSON.stringify({ cancelled }));
          },
        })
      );
      statuses.set(jobId, {
        subscription: nc.subscribe(statusSubject(jobId), {
          callback: (error, msg) => {
            if (error) return;
            const peek = jobEvents.peek(jobId);
            // Tombstone expired: stay silent so requester sees "no responders".
            if (peek.state === "unknown") return;
            msg.respond(JSON.stringify(peek satisfies JobStatusReply));
          },
        }),
      });
    } else if (event.type === "complete") {
      cancels.get(jobId)?.unsubscribe();
      cancels.delete(jobId);
      if (event.data.status === "planned") {
        stopStatus(jobId);
        return;
      }
      const status = statuses.get(jobId);
      if (status) {
        status.expire = setTimeout(() => stopStatus(jobId), TOMBSTONE_MS);
        status.expire.unref?.();
      }
    }
  });

  return () => {
    stopListening();
    for (const subscription of cancels.values()) subscription.unsubscribe();
    cancels.clear();
    for (const jobId of [...statuses.keys()]) stopStatus(jobId);
  };
}
