import express from "express";
import { getTraceBus } from "../tracing/index.js";

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
