import express from "express";
import cors from "cors";
import morgan from "morgan";
import { z } from "zod";
import createCasesRouter from "./routes/cases.router.js";
import createDiagnosisRouter from "./routes/diagnosis.router.js";
import createProceduresRouter from "./routes/procedures.router.js";
import { mountTracingRest } from "../../tracing/sse/index.js";
import type { GraphAppContext } from "../../core/graph/appContext.js";
import type { CaseGenerationService } from "../../core/caseGenerationService.js";

const RestEnvSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3030),
  })
  .transform((env) => ({ port: env.PORT }));

/**
 * Start the REST transport: an Express server exposing `/api/*`. Constructed
 * explicitly from resolved config by the composition root (`app.ts`) — no
 * loader, no topological sort, no cascade-skip. Called when the `REST` flag
 * is set.
 */
export async function startRestServer(opts: {
  graph: GraphAppContext;
  service: CaseGenerationService;
  features: Set<string>;
}): Promise<void> {
  const { graph, service, features } = opts;
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

  if (features.has("TRACING")) {
    mountTracingRest(apiRouter);
  }

  await new Promise<void>((resolve) =>
    app.listen(port, () => {
      console.log(`\n🚀 AetioMed Server running on http://localhost:${port}\n`);
      resolve();
    })
  );
}
