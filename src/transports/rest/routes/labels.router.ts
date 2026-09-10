import express from "express";
import type { JobDirectory } from "@/core/jobEvents/index.js";
import { openSse } from "../sse.js";

/**
 * `GET /api/cases/:jobId/labels` — watch any job's progress, whatever
 * submitted it and whichever replica runs it (#145). Always on (#140):
 * labels are a product feature of the streaming API, not telemetry.
 *
 * Goes through the {@link JobDirectory} port: in-process with one replica,
 * over NATS when NATS is enabled — the composition root decides, so this
 * module never imports the NATS transport.
 *
 * - unknown job → `404`, before any stream opens. This used to answer
 *   `event: complete`, so "wrong replica" and "finished" looked the same.
 * - finished job → `event: complete` with its outcome, then end.
 * - running job → `event: connected`, `event: label`…, `event: complete`.
 *
 * An observer can watch a job but not collect it: the stream never carries
 * the case (#145, "watch, not collect").
 */
export default function createLabelsRouter(
  directory: JobDirectory
): express.Router {
  const router = express.Router();

  router.get("/:jobId/labels", async (req, res) => {
    let watch;
    try {
      watch = await directory.watch(req.params.jobId);
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

    if (watch.state === "unknown") {
      res.status(404).json({
        error: { code: "NOT_FOUND", message: "No job with this jobId" },
      });
      return;
    }

    const sse = openSse(res);

    if (watch.state === "terminal") {
      sse.event("complete", watch.complete);
      sse.end();
      return;
    }

    sse.event("connected", {});
    const stop = watch.listen((event) => {
      sse.event(event.type, event.data);
      if (event.type === "complete") sse.end();
    });
    req.on("close", stop);
  });

  return router;
}
