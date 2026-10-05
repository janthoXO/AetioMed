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
  /** Finds jobs by id for label stream and `DELETE`: in-process or NATS. Chosen by composition root; no NATS import here. */
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
  // Labels and graph topology always on.
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
 * Start the REST transport. Returns a closer; shutdown owned by composition
 * root (`src/shutdown.ts`), no signal handlers here.
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
      // SSE streams hold connections open, so `server.close()` alone could
      // outlast the shutdown deadline. Destroy sockets first.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
