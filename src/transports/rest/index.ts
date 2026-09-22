import type { Server } from "node:http";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { z } from "zod";
import createCasesRouter from "./routes/cases.router.js";
import createDiagnosisRouter from "./routes/diagnosis.router.js";
import createProceduresRouter from "./routes/procedures.router.js";
import createLabelsRouter from "./routes/labels.router.js";
import createGraphRouter from "./routes/graph.router.js";
import type { GraphAppContext } from "../../core/graph/appContext.js";
import type { CaseGenerationService } from "../../core/caseGenerationService.js";
import type {
  JobDirectory,
  JobEventChannel,
} from "../../core/jobEvents/index.js";
import type { ReadModel } from "../../core/readModel.js";

const RestEnvSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3030),
  })
  .transform((env) => ({ port: env.PORT }));

export interface RestTransportHandle {
  close(): Promise<void>;
}

export interface RestAppOptions {
  graph: GraphAppContext;
  service: CaseGenerationService;
  jobEvents: JobEventChannel;
  /**
   * Where the label stream and `DELETE` find a job by id: in-process, or
   * over NATS when NATS is enabled (#145). Chosen by the composition root,
   * so this module never imports the NATS transport.
   */
  directory: JobDirectory;
  readModel: ReadModel;
  features: Set<string>;
  /** Override the POST stream's heartbeat interval — tests only. */
  heartbeatMs?: number;
}

/**
 * Build the Express app exposing `/api/*`, without listening — split from
 * {@link startRestServer} so tests can drive the real route table.
 */
export function createRestApp(opts: RestAppOptions): express.Express {
  const { graph, service, jobEvents, directory, readModel, features } = opts;

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
  apiRouter.get("/features", (_req, res) => res.json(readModel.features()));
  app.use("/api", apiRouter);

  apiRouter.use(
    "/cases",
    createCasesRouter(graph, service, jobEvents, directory, {
      ...(opts.heartbeatMs !== undefined && { heartbeatMs: opts.heartbeatMs }),
    })
  );
  // Labels and the topology they are keyed against are always on (#140):
  // they are a product feature of the streaming API, not telemetry.
  apiRouter.use("/cases", createLabelsRouter(directory));
  apiRouter.use("/", createGraphRouter(readModel));
  apiRouter.use("/diagnosis", createDiagnosisRouter(readModel));
  apiRouter.use("/procedures", createProceduresRouter(readModel));
  apiRouter.get("/allowedLlms", (_req, res) =>
    res.json(readModel.allowedLlms())
  );

  return app;
}

/**
 * Start the REST transport. Constructed explicitly from resolved config by
 * the composition root (`app.ts`) — no loader, no topological sort, no
 * cascade-skip. Called when the `REST` flag is set.
 *
 * Returns a closer rather than registering its own signal handlers — see
 * `src/shutdown.ts` for why shutdown is owned by the composition root.
 */
export async function startRestServer(
  opts: RestAppOptions
): Promise<RestTransportHandle> {
  const { port } = RestEnvSchema.parse(process.env);
  const app = createRestApp(opts);

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, () => {
      console.log(`\n🚀 AetioMed Server running on http://localhost:${port}\n`);
      resolve(s);
    });
  });

  return {
    async close() {
      // `server.close()` alone stops accepting new connections and then
      // waits for existing ones to end — but an SSE label stream
      // (`GET /api/cases/:jobId/labels`) holds its connection open by
      // design, so that wait could outlast the shutdown deadline. Destroy
      // every open socket first so close() can actually resolve.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
