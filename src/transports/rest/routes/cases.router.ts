import express from "express";
import { makeCaseGenerationRequestSchema } from "@/api/index.js";
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

  const successBody = (result: CaseGenerationResult) =>
    CaseGenerationResponseSchema.parse({
      ...encodeCase(result.case!, graph.config.MAX_CONTENT_PART_BYTES),
      jobId: result.jobId,
      language: result.language,
    });

  /**
   * `POST /api/cases` — the synchronous transport (design doc §D1, §D3).
   *
   * - `Accept: application/json` (or no preference): blocks and returns the
   *   case, exactly as before.
   * - `Accept: text/event-stream`: SSE on the POST's own response —
   *   `event: accepted {jobId}` before any node runs, then `event: label`…,
   *   then `event: result {case…}` or `event: error {error}`, with a
   *   `: ping` comment every {@link HEARTBEAT_MS}.
   *
   * The stream is opened by the request itself, so no event can be lost
   * between learning the jobId and subscribing — which a 202-then-subscribe
   * design cannot promise without a replay buffer.
   *
   * On either path a client disconnect cancels the job. That is the
   * accepted trade of a connection-scoped transport, not an oversight:
   * HTTP cannot tell "the user cancelled" from "the network dropped". A
   * client that needs to survive drops uses NATS.
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

    const started = service.start(bodyResult.data);
    const { jobId } = started;

    // A duplicate jobId is a plain 409 on both paths, answered before any
    // stream opens: a retry must never start a second generation, nor
    // silently attach to someone else's.
    if (!started.accepted) {
      res.status(409).json(errorBody(started.result));
      return;
    }

    res.on("close", () => {
      if (!res.writableFinished) service.cancel(jobId);
    });

    const wantsStream =
      req.accepts(["application/json", "text/event-stream"]) ===
      "text/event-stream";

    if (!wantsStream) {
      const result = await started.result;
      if (res.writableEnded) return;
      if (result.status === "done") {
        res.status(200).json(successBody(result));
      } else if (result.error!.code === "GENERATION_CANCELLED") {
        res.status(result.error!.statusCode ?? 499).end();
      } else {
        res.status(result.error!.statusCode ?? 500).json(errorBody(result));
      }
      return;
    }

    const sse = openSse(res);
    sse.event("accepted", { jobId });

    // Subscribed synchronously after `start`, which opened the channel:
    // nothing can have run yet.
    const subscription = jobEvents.subscribe(jobId, (event) => {
      if (event.type === "label") sse.event("label", event.data);
    });
    const heartbeat = setInterval(() => sse.comment("ping"), heartbeatMs);

    try {
      const result = await started.result;
      if (result.status === "done") {
        sse.event("result", successBody(result));
      } else {
        sse.event("error", errorBody(result));
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
  });

  /**
   * `DELETE /api/cases/:jobId` — cancel any job, whatever submitted it and
   * whichever replica runs it (#145), through the {@link JobDirectory}. With
   * NATS enabled this is a request to `cases.cancel.<jobId>`, answered only
   * by the owner, so the answer is synchronous and exact: 204 when it was
   * cancelled, 404 when no replica runs it (never started, or finished), 504
   * when the owner could not be reached in time.
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
