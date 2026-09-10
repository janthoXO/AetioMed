import type { Server } from "node:http";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { z } from "zod";
import createCasesRouter from "./routes/cases.router.js";
import createDiagnosisRouter from "./routes/diagnosis.router.js";
import createProceduresRouter from "./routes/procedures.router.js";
import createTracesRouter from "./routes/traces.router.js";
import createStructureRouter from "../../tracing/structure/router.js";
import type { GraphAppContext } from "../../core/graph/appContext.js";
import type { CaseGenerationService } from "../../core/caseGenerationService.js";
import type { JobEventChannel } from "../../core/jobEvents/index.js";

const RestEnvSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3030),
  })
  .transform((env) => ({ port: env.PORT }));

export interface RestTransportHandle {
  close(): Promise<void>;
}

/**
 * Start the REST transport: an Express server exposing `/api/*`. Constructed
 * explicitly from resolved config by the composition root (`app.ts`) — no
 * loader, no topological sort, no cascade-skip. Called when the `REST` flag
 * is set.
 *
 * Returns a closer rather than registering its own signal handlers — see
 * `src/shutdown.ts` for why shutdown is owned by the composition root.
 */
export async function startRestServer(opts: {
  graph: GraphAppContext;
  service: CaseGenerationService;
  jobEvents: JobEventChannel;
  features: Set<string>;
}): Promise<RestTransportHandle> {
  const { graph, service, jobEvents, features } = opts;
  const { port } = RestEnvSchema.parse(process.env);

  const app = express();
  app.use(express.json());

  if (features.has("DEBUG")) {
    app.use(cors());
    app.use(morgan("dev"));
  }

  const apiRouter = express.Router();
  apiRouter.get("/health", (_req, res) =>
    res.json({ status: "ok", timestamp: new Date().toISOString() })
  );
  apiRouter.get("/features", (_req, res) => res.json([...features]));
  app.use("/api", apiRouter);

  apiRouter.use("/cases", createCasesRouter(graph, service));
  apiRouter.use("/diagnosis", createDiagnosisRouter(graph));
  apiRouter.use("/procedures", createProceduresRouter(graph));
  apiRouter.get("/allowedLlms", (_req, res) =>
    res.json(graph.config.allowedLlms || [])
  );

  // The live per-job stream and the compiled graph structure: only
  // meaningful once a client can see the pipeline it is driving.
  if (features.has("TRACING")) {
    apiRouter.use("/", createTracesRouter(jobEvents));
    apiRouter.use("/", createStructureRouter(graph.caseGraph));
  }

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, () => {
      console.log(`\n🚀 AetioMed Server running on http://localhost:${port}\n`);
      resolve(s);
    });
  });

  return {
    async close() {
      // `server.close()` alone stops accepting new connections and then
      // waits for existing ones to end — but under `FEATURES=TRACING` the
      // SSE stream (`GET /api/traces/:jobId/stream`) holds connections open
      // indefinitely by design, so that wait would never finish. Destroy
      // every open socket first so close() can actually resolve.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
