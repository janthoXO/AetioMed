import express from "express";
import { makeCaseGenerationRequestSchema } from "@/api/index.js";
import { CaseGenerationResponseSchema } from "@/api/index.js";
import { encodeCase } from "@/api/contentWire.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type {
  CaseGenerationResult,
  CaseGenerationService,
  PlanPayload,
} from "@/core/caseGenerationService.js";
import type { JobDirectory, JobEventChannel } from "@/core/jobEvents/index.js";
import { openSse, type SseStream } from "../sse.js";

/**
 * Interval of the POST stream's `: ping` comment. Independent of label
 * cadence: one node can be silent for minutes, long enough for a proxy to
 * drop the idle connection.
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

/** Plan-mode stop; same payload as normal-mode `event: plan`. */
function planBody(result: CaseGenerationResult): PlanPayload {
  return {
    jobId: result.jobId,
    mode: "plan",
    language: result.language!,
    plan: result.plan!,
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
   * `POST /api/cases` — synchronous transport. Stream opens with the request,
   * so no events are lost between minting jobId and subscribing.
   *
   * - `Accept: application/json` (or none): blocks; returns case (200),
   *   plan-mode plan (200, `{jobId, mode, language, plan}`), or error.
   * - `Accept: text/event-stream`: SSE — `event: accepted {jobId}` before
   *   any node runs, `event: label`…, `event: plan` once plan exists, then
   *   `event: result`/`event: error`; plan-mode ends with the plan. `: ping`
   *   every {@link HEARTBEAT_MS}.
   *
   * Body with `plan` generates from it; same jobId as plan's call is fine.
   * Client disconnect cancels job.
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

    // Set once response is a stream; JSON path drops normal-mode plan.
    const stream: { sse?: SseStream } = {};
    const started = service.start(bodyResult.data, {
      onPlan: (plan) => stream.sse?.event("plan", plan),
    });
    const { jobId } = started;

    // Duplicate jobId: plain 409 on both paths, before any stream opens.
    // Never start a second generation or attach to another's.
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
      const finished = await started.result;
      if (res.writableEnded) return;
      if (finished.status === "done") {
        res.status(200).json(successBody(finished));
      } else if (finished.status === "planned") {
        res.status(200).json(planBody(finished));
      } else if (finished.error!.code === "GENERATION_CANCELLED") {
        res.status(finished.error!.statusCode ?? 499).end();
      } else {
        res.status(finished.error!.statusCode ?? 500).json(errorBody(finished));
      }
      return;
    }

    const sse = openSse(res);
    stream.sse = sse;
    sse.event("accepted", { jobId });

    // Synchronous after `start` opened the channel: nothing has run yet.
    const subscription = jobEvents.subscribe(jobId, (event) => {
      if (event.type === "label") sse.event("label", event.data);
    });
    const heartbeat = setInterval(() => sse.comment("ping"), heartbeatMs);

    try {
      const finished = await started.result;
      if (finished.status === "done") {
        sse.event("result", successBody(finished));
      } else if (finished.status === "planned") {
        sse.event("plan", planBody(finished));
      } else {
        sse.event("error", errorBody(finished));
      }
    } catch (error) {
      // Headers already sent: Express can't 500, stream must report failure.
      // Likely cause: content part over `MAX_CONTENT_PART_BYTES` (`contentWire.ts`).
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
   * `DELETE /api/cases/:jobId` — cancel any job on any replica via
   * {@link JobDirectory}. 204 cancelled, 404 no replica runs it (never
   * started or finished), 504 owner unreachable.
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
