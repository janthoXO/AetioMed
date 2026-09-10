import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import { JobIdSchema } from "@/api/index.js";
import type { CaseGenerationService } from "@/core/caseGenerationService.js";
import type { JobEventChannel } from "@/core/jobEvents/index.js";
import { cancelSubject } from "./subjects.js";

/**
 * Answer `cases.cancel.<jobId>` for every job this process runs, whatever
 * transport submitted it. Ownership is expressed as subscription interest:
 * this replica subscribes to a job's cancel subject when the job is
 * accepted and unsubscribes when it completes, so a request reaches exactly
 * the replica that owns the job. An unknown or finished job has no
 * subscriber, and the requester gets NATS's "no responders" at once — never a
 * wrong `{cancelled: false}` from a replica that merely does not own it
 * (#142). `{cancelled: false}` only happens when the job finished between
 * the request and the abort.
 *
 * Returns a function that stops answering.
 */
export function startJobResponders(opts: {
  nc: NatsConnection;
  jobEvents: JobEventChannel;
  service: CaseGenerationService;
}): () => void {
  const { nc, jobEvents, service } = opts;
  const subscriptions = new Map<string, Subscription>();

  const stopListening = jobEvents.subscribeAll((jobId, event) => {
    if (event.type === "accepted") {
      // Every jobId that reaches the service is validated against
      // `JobIdSchema`, but a subject built from anything else would address
      // a different subject — so never trust it blindly here.
      if (!JobIdSchema.safeParse(jobId).success) {
        console.warn(
          `[NATS] jobId=${jobId} is not a subject token; not cancellable over NATS`
        );
        return;
      }
      subscriptions.set(
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
    } else if (event.type === "complete") {
      subscriptions.get(jobId)?.unsubscribe();
      subscriptions.delete(jobId);
    }
  });

  return () => {
    stopListening();
    for (const subscription of subscriptions.values())
      subscription.unsubscribe();
    subscriptions.clear();
  };
}
