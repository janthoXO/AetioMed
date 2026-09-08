import type express from "express";
import traceRouter from "./router.js";
import createStructureRouter from "../structure/router.js";
import type { CompiledCaseGraph } from "@/core/graph/02graphs/caseGraph.js";

/**
 * Mount the TRACING-gated REST routes onto the given API router: the SSE
 * live-trace stream (`GET /traces/:jobId/stream`) and, issue 15 §4, the
 * compiled graph structure (`GET /graph`) — both live next to each other
 * because both are only meaningful once a client can see the pipeline
 * they're driving. Called from `rest/index.ts` when both `REST` and
 * `TRACING` are enabled.
 */
export function mountTracingRest(
  apiRouter: express.Router,
  caseGraph: CompiledCaseGraph
): void {
  console.log(
    "[tracing/sse] Mounting live trace stream and graph structure routes..."
  );
  apiRouter.use("/", traceRouter);
  apiRouter.use("/", createStructureRouter(caseGraph));
}
