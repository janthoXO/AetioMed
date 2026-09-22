import express from "express";
import {
  makeCaseGenerationRequestSchema,
  makeReviewDecisionRequestSchema,
} from "@/api/index.js";
import { CaseGenerationResponseSchema } from "@/api/index.js";
import { encodeCase } from "@/api/contentWire.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type {
  CaseGenerationResult,
  CaseGenerationService,
} from "@/core/caseGenerationService.js";
import type { JobDirectory, JobEventChannel } from "@/core/jobEvents/index.js";
import { openSse } from "../sse.js";

/**
 * How often the POST stream writes a `: ping` comment. Holding the
 * connection open must not depend on label cadence: labels fire on node
 * boundaries, and one node (outline generation on a local model, one solver
 * iteration) can be silent for minutes — long enough for a proxy to close
 * what it sees as an idle connection (#143).
 */
export const HEARTBEAT_MS = 15_000;

function errorBody(result: CaseGenerationResult) {
  const error = result.error!;
  return {
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
    },
  };
}

export default function createCasesRouter(
  graph: GraphAppContext,
  service: CaseGenerationService,
  jobEvents: JobEventChannel,
  directory: JobDirectory,
  opts: { heartbeatMs?: number } = {}
) {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const router = express.Router();
  const CaseGenerationRequestSchema = makeCaseGenerationRequestSchema(
    graph.config
  );
  const ReviewDecisionRequestSchema = makeReviewDecisionRequestSchema(
    graph.config
  );

  const successBody = (result: CaseGenerationResult) =>
    CaseGenerationResponseSchema.parse({
      ...encodeCase(result.case!, graph.config.MAX_CONTENT_PART_BYTES),
      jobId: result.jobId,
      language: result.language,
    });

  /** The body of a 202/`event: review` stop — the same shape either way. */
  const reviewBody = (result: CaseGenerationResult) => ({
    jobId: result.jobId,
    status: "awaiting_review" as const,
    language: result.language,
    review: result.review,
  });

  /**
   * Answer one **segment** — a create (`POST /`) or a decide
   * (`POST /:jobId/review`) — on the request's own response, shared by both
   * (#159). A segment ends at its first stop: `done`, `failed`, or
   * `awaiting_review`, and every stop is answered here, on this one
   * response — a paused job holds no connection of its own (see the module
   * doc comment above `POST /`).
   *
   * - `Accept: application/json` (or no preference): blocks and returns the
   *   stop — the case (200), the review (202), or the error.
   * - `Accept: text/event-stream`: SSE on this response — `event: accepted
   *   {jobId}` before any node runs, then `event: label`…, then `event:
   *   result`/`event: review`/`event: error`, with a `: ping` comment every
   *   {@link HEARTBEAT_MS}.
   *
   * A client disconnect cancels the job **only while this segment is still
   * running** — `res.on("close")` fires up to the point this response ends,
   * and a segment's stop always ends the response (there is no connection
   * left open across a pause to cancel through).
   */
  async function respondWithSegment(
    req: express.Request,
    res: express.Response,
    jobId: string,
    result: Promise<CaseGenerationResult>
  ): Promise<void> {
    res.on("close", () => {
      if (!res.writableFinished) service.cancel(jobId);
    });

    const wantsStream =
      req.accepts(["application/json", "text/event-stream"]) ===
      "text/event-stream";

    if (!wantsStream) {
      const finished = await result;
      if (res.writableEnded) return;
      if (finished.status === "done") {
        res.status(200).json(successBody(finished));
      } else if (finished.status === "awaiting_review") {
        res.status(202).json(reviewBody(finished));
      } else if (finished.error!.code === "GENERATION_CANCELLED") {
        res.status(finished.error!.statusCode ?? 499).end();
      } else {
        res.status(finished.error!.statusCode ?? 500).json(errorBody(finished));
      }
      return;
    }

    const sse = openSse(res);
    sse.event("accepted", { jobId });

    // Subscribed synchronously after the segment started, which opened (or
    // already held open) the channel: nothing can have run yet.
    const subscription = jobEvents.subscribe(jobId, (event) => {
      if (event.type === "label") sse.event("label", event.data);
    });
    const heartbeat = setInterval(() => sse.comment("ping"), heartbeatMs);

    try {
      const finished = await result;
      if (finished.status === "done") {
        sse.event("result", successBody(finished));
      } else if (finished.status === "awaiting_review") {
        sse.event("review", reviewBody(finished));
      } else {
        sse.event("error", errorBody(finished));
      }
    } catch (error) {
      // The headers are long gone, so Express's error handler cannot turn
      // this into a 500 — the stream must say it failed itself. The likely
      // cause is encoding the result: a content part over
      // `MAX_CONTENT_PART_BYTES` fails loudly by design (`contentWire.ts`).
      console.error(
        `[rest] Failed to finish the stream for jobId=${jobId}`,
        error
      );
      sse.event("error", {
        error: {
          code: "GENERATION_FAILED",
          message: "Internal server error",
          details: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      clearInterval(heartbeat);
      if (subscription.state === "active") subscription.unsubscribe();
      sse.end();
    }
  }

  /**
   * `POST /api/cases` — the synchronous transport (#143), now segmented
   * (#159): a plan-mode job's first segment stops at `awaiting_review`
   * instead of running to the end, and `POST /:jobId/review` below runs its
   * next segment the same way. Opening the stream with the request itself
   * removes the handshake race a 202-then-subscribe design has: every event
   * between minting the jobId and the client subscribing would otherwise be
   * lost, short of a replay buffer (deferred).
   */
  router.post("/", async (req: express.Request, res: express.Response) => {
    const bodyResult = CaseGenerationRequestSchema.safeParse(req.body);

    if (!bodyResult.success) {
      console.error("Invalid request body", req.body);
      res.status(400).json({
        error: {
          code: "INVALID_REQUEST_BODY",
          message: "Invalid request body",
          details: JSON.stringify(bodyResult.error.issues),
        },
      });
      return;
    }

    const started = service.start(bodyResult.data, { transport: "rest" });
    const { jobId } = started;

    // A duplicate jobId is a plain 409 on both paths, answered before any
    // stream opens: a retry must never start a second generation, nor
    // silently attach to someone else's.
    if (!started.accepted) {
      res.status(409).json(errorBody(started.result));
      return;
    }

    await respondWithSegment(req, res, jobId, started.result);
  });

  /**
   * `GET /api/cases/:jobId/review` — the pending review of a paused job
   * (#159), or `404` when there is none (never paused, already decided, or
   * finished/expired). This is a plain read, not part of a segment: it
   * never opens a stream and never advances the job.
   */
  router.get("/:jobId/review", (req, res) => {
    const review = service.getReview(req.params.jobId);
    if (!review) {
      res.status(404).json({
        error: {
          code: "NOT_FOUND",
          message: "No pending review for this jobId",
        },
      });
      return;
    }
    res.status(200).json(review);
  });

  /**
   * `POST /api/cases/:jobId/review` — a reviewer's decision on a paused job
   * (#159). A bad body is a `400` (`INVALID_REQUEST_BODY`, zod issues in
   * `details`); a refused decision (stale revision, not awaiting review,
   * review rounds exhausted, changed fixed segment, wrong segment count,
   * unknown job) is answered with `error.statusCode` and never opens a
   * stream. An accepted decision runs the job's next segment and answers
   * exactly like `POST /`, through {@link respondWithSegment} — including
   * `event: accepted {jobId}` on the SSE path, since this call is what
   * (re)starts the connection a paused job otherwise holds none of.
   */
  router.post("/:jobId/review", async (req, res) => {
    const bodyResult = ReviewDecisionRequestSchema.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        error: {
          code: "INVALID_REQUEST_BODY",
          message: "Invalid request body",
          details: JSON.stringify(bodyResult.error.issues),
        },
      });
      return;
    }

    const outcome = service.decide(req.params.jobId, bodyResult.data);
    if (!outcome.accepted) {
      res.status(outcome.error.statusCode ?? 500).json({
        error: { code: outcome.error.code, message: outcome.error.message },
      });
      return;
    }

    await respondWithSegment(req, res, outcome.jobId, outcome.result);
  });

  /**
   * `DELETE /api/cases/:jobId` — cancel any job, whatever submitted it and
   * whichever replica runs it (#145), through the {@link JobDirectory}. With
   * NATS enabled this is a request to `cases.cancel.<jobId>`, answered only
   * by the owner, so the answer is synchronous and exact: 204 when it was
   * cancelled, 404 when no replica runs it (never started, or finished), 504
   * when the owner could not be reached in time. Cancelling ends a paused
   * job too (#159) — `service.cancel` already handles that; this route
   * needed no change for plan mode.
   */
  router.delete("/:jobId", async (req, res) => {
    const { jobId } = req.params;
    let result;
    try {
      result = await directory.cancel(jobId);
    } catch (error) {
      console.error("[rest] Could not reach the job's owner", error);
      res.status(504).json({
        error: {
          code: "UPSTREAM_TIMEOUT",
          message: "Could not reach the replica that owns this job",
        },
      });
      return;
    }

    if (result === "cancelled") {
      res.status(204).end();
      return;
    }
    res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message:
          result === "finished"
            ? "This job has already finished"
            : "No active generation for this jobId",
      },
    });
  });

  return router;
}
