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
 * Answer per-job requests for every job this process runs, whatever
 * transport submitted it. Ownership is expressed as subscription interest:
 * this replica subscribes to a job's subjects when the job is accepted, so a
 * request reaches exactly the replica that owns the job. A job no replica
 * knows has no subscriber, and the requester gets NATS's "no responders" at
 * once — never a wrong answer from a replica that merely does not own it.
 *
 * - `cases.cancel.<jobId>` → `{cancelled}`, while the job runs (#142).
 *   `{cancelled: false}` only happens when the job finished between the
 *   request and the abort.
 * - `cases.status.<jobId>` → `{state: "active"}` while it runs, then
 *   `{state: "terminal", complete}` for the channel's tombstone window
 *   (#145). That is what lets an observer on another replica tell
 *   "finished" from "never existed". A `planned` job stops answering at
 *   once (#159): its continuation, with the same jobId, may run on any
 *   replica, and this one must not answer for it.
 *
 * Returns a function that stops answering.
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
      // Every jobId that reaches the service is validated against
      // `JobIdSchema`, but a subject built from anything else would address
      // a different subject — so never trust it blindly here.
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
            // Unknown here means the tombstone just expired: stay silent,
            // so the requester sees "no responders", exactly as for a job
            // that never existed.
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
