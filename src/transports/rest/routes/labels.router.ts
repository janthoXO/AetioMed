import express from "express";
import type { JobEvent, JobEventChannel } from "@/core/jobEvents/index.js";
import { openSse } from "../sse.js";

/**
 * `GET /api/cases/:jobId/labels` — the SSE adapter onto the core-owned
 * per-job channel (#139). Always on (#140): labels are a product feature of
 * the streaming API, not telemetry.
 *
 * Carries `event: label` frames and ends with `event: complete`. It never
 * carries node output — that is the operator's, over OTLP — and never the
 * case: an observer is not the requester (design doc §D4).
 */
export default function createLabelsRouter(
  channel: JobEventChannel
): express.Router {
  const router = express.Router();

  router.get("/:jobId/labels", (req, res) => {
    const sse = openSse(res);

    const onEvent = (event: JobEvent) => {
      if (event.type === "label") {
        sse.event("label", event.data);
      } else if (event.type === "complete") {
        sse.event("complete", event.data);
        sse.end();
      }
    };

    const subscription = channel.subscribe(req.params.jobId, onEvent);

    if (subscription.state !== "active") {
      sse.event(
        "complete",
        subscription.state === "terminal" ? subscription.complete : {}
      );
      sse.end();
      return;
    }

    sse.event("connected", {});

    // Unsubscribing is the "last consumer disconnected" signal the channel
    // waits on before it releases a terminal job (issue 15 §2).
    req.on("close", subscription.unsubscribe);
  });

  return router;
}
