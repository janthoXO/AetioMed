import type express from "express";
import traceRouter from "./router.js";

/**
 * Mount the SSE live-trace route (`GET /traces/:jobId/stream`) onto the
 * given API router. Called from `rest/index.ts` when both `REST` and
 * `TRACING` are enabled.
 */
export function mountTracingRest(apiRouter: express.Router): void {
  console.log("[tracing/sse] Mounting live trace stream route...");
  apiRouter.use("/", traceRouter);
}
