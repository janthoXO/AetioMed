import express from "express";
import { getTraceBus } from "./traceManager.js";

const router = express.Router();

router.use((_req, _res, next) => {
  /* #swagger.tags = ['Traces'] */
  next();
});

router.get("/traces/:traceId/stream", (req, res) => {
  const { traceId } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders(); // flush the headers to establish SSE

  const bus = getTraceBus(traceId);

  if (!bus) {
    // If bus not found (maybe finished or invalid), just close the stream
    res.write("event: complete\ndata: {}\n\n");
    res.end();
    return;
  }

  // Send an initial connected ping
  res.write("event: connected\ndata: {}\n\n");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onTrace = (data: any) => {
    res.write(`event: trace\ndata: ${JSON.stringify(data)}\n\n`);
  };

  bus.on("trace", onTrace);

  req.on("close", () => {
    bus.off("trace", onTrace);
  });
});

export default router;
