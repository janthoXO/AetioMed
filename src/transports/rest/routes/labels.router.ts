import express from "express";
import type { JobDirectory } from "@/core/jobEvents/index.js";
import { openSse } from "../sse.js";

/**
 * `GET /api/cases/:jobId/labels` — watch any job's progress on any replica
 * via {@link JobDirectory} (in-process or NATS, chosen by composition root).
 *
 * - unknown job → `404`, before any stream opens.
 * - finished job → `event: complete` with outcome, then end.
 * - running job → `event: connected`, `event: label`…, `event: complete`.
 *
 * Plan-mode call ends with `event: complete` status `planned`; only the
 * requester sees the plan. Stream never carries the case: watch, not collect.
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
