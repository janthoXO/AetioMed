import { encodeCase } from "@/api/contentWire.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type { CaseGenerationResult } from "@/core/caseGenerationService.js";
import { getJetStreamClient } from "./client.js";
import { resultSubject, reviewSubject } from "./subjects.js";

/**
 * Publish a job's result into `CASE_RESULTS` on its own subject. The
 * `msgID` makes a redelivered job's second result a no-op within the
 * stream's duplicate window.
 */
export async function publishCaseResult(
  jobId: string,
  response: Record<string, unknown>
): Promise<void> {
  const js = getJetStreamClient();
  const payload = { jobId, ...response };

  console.log(`[NATS] Publishing result for jobId=${jobId}`);

  await js.publish(resultSubject(jobId), JSON.stringify(payload), {
    msgID: `result-${jobId}`,
  });
}

/**
 * Publish a plan-mode pause into `CASE_REVIEWS` on its own subject (#159).
 * `msgID` is keyed on `revision`, not just `jobId`: unlike a result, a job
 * can pause more than once (a revision, a resubmitted edit), and each pause
 * is a distinct message a reconnecting client should be able to replay.
 */
async function publishReview(
  jobId: string,
  review: CaseGenerationResult["review"]
): Promise<void> {
  const js = getJetStreamClient();

  console.log(
    `[NATS] Publishing review for jobId=${jobId} revision=${review!.revision}`
  );

  await js.publish(reviewSubject(jobId), JSON.stringify(review), {
    msgID: `review-${jobId}-${review!.revision}`,
  });
}

/**
 * Deliver a job's first stop — the one thing every caller of `generate`
 * (the request worker, the decision responder, `resume`, and detached
 * outcomes) needs (#159). One function, so "what a stop publishes" is
 * decided once: `awaiting_review` goes to `cases.review.<jobId>`, `done`
 * and `failed` go to the existing `cases.result.<jobId>` exactly as before.
 */
export async function publishStop(
  graph: GraphAppContext,
  result: CaseGenerationResult
): Promise<void> {
  if (result.status === "awaiting_review") {
    await publishReview(result.jobId, result.review);
    return;
  }
  if (result.status === "done") {
    await publishCaseResult(result.jobId, {
      ...encodeCase(result.case!, graph.config.MAX_CONTENT_PART_BYTES),
      language: result.language,
    });
    return;
  }
  await publishCaseResult(result.jobId, {
    error: {
      code: result.error!.code,
      message: result.error!.message,
      details: result.error!.details,
    },
  });
}
