import express from "express";
import { getTraceBus, registerConsumer, unregisterConsumer } from "../index.js";
import type { TraceEvent, LabelEvent } from "../index.js";

const router = express.Router();

router.use((_req, _res, next) => {
  /* #swagger.tags = ['Traces'] */
  next();
});

router.get("/traces/:jobId/stream", (req, res) => {
  const { jobId } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const bus = getTraceBus(jobId);

  if (!bus) {
    res.write("event: complete\ndata: {}\n\n");
    res.end();
    return;
  }

  res.write("event: connected\ndata: {}\n\n");
  registerConsumer(jobId);

  // Issue 15 §1.2/§3 — two separate SSE event types, not one `type`-
  // discriminated stream: `label` (localized, end-user progress text) and
  // `trace` (English, node output for an operator) have different
  // audiences, so a consumer of one should never have to filter the other
  // out of its own event handler.
  const onTrace = (data: TraceEvent) => {
    res.write(`event: trace\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const onLabel = (data: LabelEvent) => {
    res.write(`event: label\ndata: ${JSON.stringify(data)}\n\n`);
  };

  bus.on("trace", onTrace);
  bus.on("label", onLabel);

  req.on("close", () => {
    bus.off("trace", onTrace);
    bus.off("label", onLabel);
    // Issue 15 §2 — the deterministic half of the bus-teardown fix: this is
    // the "last consumer disconnected" signal `traceManager.ts`'s
    // `maybeTeardown` waits on instead of a hardcoded timer.
    unregisterConsumer(jobId);
  });
});

export default router;
