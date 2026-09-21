import type {
  NatsConnection,
  Msg,
  Subscription,
} from "@nats-io/transport-node";
import { JobIdSchema, ReviewDecisionRequestSchema } from "@/api/index.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type { CaseGenerationService } from "@/core/caseGenerationService.js";
import {
  TOMBSTONE_MS,
  type JobEventChannel,
  type JobPeek,
} from "@/core/jobEvents/index.js";
import { publishStop } from "./cases.publisher.js";
import { cancelSubject, decisionSubject, statusSubject } from "./subjects.js";

/**
 * What `cases.status.<jobId>` answers — never `unknown`: nobody answers
 * then. `awaiting_review` is added by #159: a paused job is still `active`
 * on the channel (it never closes), so `jobEvents.peek` alone cannot tell a
 * running segment from one waiting on a reviewer — `service.getReview`
 * answers that distinction instead.
 */
export type JobStatusReply =
  | Exclude<JobPeek, { state: "unknown" }>
  | { state: "awaiting_review"; revision: number };

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
 * - `cases.status.<jobId>` → `{state: "active"}` while it runs,
 *   `{state: "awaiting_review", revision}` while paused for a reviewer
 *   (#159), then `{state: "terminal", complete}` for the channel's
 *   tombstone window (#145). That is what lets an observer on another
 *   replica tell "finished" from "never existed".
 * - `cases.decision.<jobId>` → `{accepted}` (#159), answered by the same
 *   owning-replica rule: subscribed on `accepted`, unsubscribed on
 *   `complete`. A paused job never emits `complete` (the channel stays open
 *   across a review, #159), so this subscription — like `cancel`'s — is
 *   naturally still live for as long as the job can be decided on.
 *
 * Returns a function that stops answering.
 */
export function startJobResponders(opts: {
  nc: NatsConnection;
  graph: GraphAppContext;
  jobEvents: JobEventChannel;
  service: CaseGenerationService;
}): () => void {
  const { nc, graph, jobEvents, service } = opts;
  const cancels = new Map<string, Subscription>();
  const decisions = new Map<string, Subscription>();
  const statuses = new Map<
    string,
    { subscription: Subscription; expire?: ReturnType<typeof setTimeout> }
  >();

  /**
   * `cases.decision.<jobId>` (#159): reply `{accepted:true}` immediately —
   * before the next segment runs — then deliver its result through
   * `publishStop`, exactly as the request worker delivers a first segment's
   * stop. Invalid JSON/body never reaches `service.decide`; a refusal
   * (stale revision, invalid outline, not paused) is answered synchronously
   * and nothing is published — there is no new stop to deliver.
   */
  async function handleDecision(jobId: string, msg: Msg): Promise<void> {
    let body: unknown;
    try {
      body = msg.json();
    } catch {
      msg.respond(
        JSON.stringify({
          accepted: false,
          error: { code: "INVALID_REQUEST_BODY", message: "Invalid JSON body" },
        })
      );
      return;
    }

    const parsed = ReviewDecisionRequestSchema.safeParse(body);
    if (!parsed.success) {
      msg.respond(
        JSON.stringify({
          accepted: false,
          error: {
            code: "INVALID_REQUEST_BODY",
            message: "Invalid request body",
            details: JSON.stringify(parsed.error.issues),
          },
        })
      );
      return;
    }

    const outcome = service.decide(jobId, parsed.data);
    if (!outcome.accepted) {
      msg.respond(
        JSON.stringify({
          accepted: false,
          error: { code: outcome.error.code, message: outcome.error.message },
        })
      );
      return;
    }

    msg.respond(JSON.stringify({ accepted: true }));
    const result = await outcome.result;
    await publishStop(graph, result);
  }

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
      decisions.set(
        jobId,
        nc.subscribe(decisionSubject(jobId), {
          callback: (error, msg) => {
            if (error) return;
            handleDecision(jobId, msg).catch((decisionError) => {
              console.error(
                `[NATS] Decision handling failed for jobId=${jobId}`,
                decisionError
              );
            });
          },
        })
      );
      statuses.set(jobId, {
        subscription: nc.subscribe(statusSubject(jobId), {
          callback: (error, msg) => {
            if (error) return;
            // A paused job never closes its channel (#159), so `peek`
            // alone would answer `{state: "active"}` for it too —
            // `getReview` is what actually distinguishes the two.
            const review = service.getReview(jobId);
            if (review) {
              msg.respond(
                JSON.stringify({
                  state: "awaiting_review",
                  revision: review.revision,
                } satisfies JobStatusReply)
              );
              return;
            }
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
      decisions.get(jobId)?.unsubscribe();
      decisions.delete(jobId);
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
    for (const subscription of decisions.values()) subscription.unsubscribe();
    decisions.clear();
    for (const jobId of [...statuses.keys()]) stopStatus(jobId);
  };
}
