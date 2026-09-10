import express from "express";
import type { JobEvent, JobEventChannel } from "@/core/jobEvents/index.js";

/**
 * The SSE adapter onto the core-owned per-job channel. It was in
 * `src/tracing/sse/` only by accident; it is a transport (#139).
 *
 * `label` (localized, end-user progress text) and `trace` (English, node
 * output for an operator) are separate SSE event types, not one
 * `type`-discriminated stream (issue 15 §3): a consumer of one should never
 * have to filter the other out of its own handler. The stream ends with
 * `event: complete` once the job is terminal.
 */
export default function createTracesRouter(
  channel: JobEventChannel
): express.Router {
  const router = express.Router();

  router.get("/traces/:jobId/stream", (req, res) => {
    const { jobId } = req.params;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const write = (type: string, data: unknown) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

    const onEvent = (event: JobEvent) => {
      if (event.type === "label" || event.type === "trace") {
        write(event.type, event.data);
      } else if (event.type === "complete") {
        write("complete", event.data);
        res.end();
      }
    };

    const subscription = channel.subscribe(jobId, onEvent);

    if (subscription.state !== "active") {
      write(
        "complete",
        subscription.state === "terminal" ? subscription.complete : {}
      );
      res.end();
      return;
    }

    write("connected", {});

    // Unsubscribing is the "last consumer disconnected" signal the channel
    // waits on before it releases a terminal job (issue 15 §2).
    req.on("close", subscription.unsubscribe);
  });

  return router;
}
