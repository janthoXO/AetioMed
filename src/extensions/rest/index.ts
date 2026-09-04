import express from "express";
import cors from "cors";
import morgan from "morgan";
import { z } from "zod";
import { defineExtension } from "../../core/extension.js";
import createCasesRouter from "./routes/cases.router.js";
import diagnosisRouter from "./routes/diagnosis.router.js";
import createProceduresRouter from "./routes/procedures.router.js";
import { extension as apiExtension } from "../api/index.js";

/** Shared router mounted at /api — other extensions import this to mount sub-routes. */
export let apiRouter: express.Router;

const RestEnvSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3030),
    FEATURES: z.string().default(""),
  })
  .transform((env) => ({
    port: env.PORT,
    features: env.FEATURES.split(",")
      .map((f) => f.trim())
      .filter(Boolean),
  }));

export const extension = defineExtension({
  name: "rest",
  requiredFlags: ["REST"],
  envSchema: RestEnvSchema,
  dependsOn: [apiExtension] as const,

  async setup({ config: { port, features }, graph, bus }) {
    const app = express();
    app.use(express.json());

    if (features.includes("DEBUG")) {
      app.use(cors());
      app.use(morgan("dev"));
    }

    apiRouter = express.Router();
    apiRouter.get("/health", (_req, res) =>
      res.json({ status: "ok", timestamp: new Date().toISOString() })
    );
    apiRouter.get("/features", (_req, res) => res.json(features));
    app.use("/api", apiRouter);

    apiRouter.use("/cases", createCasesRouter(graph, bus));
    apiRouter.use("/diagnosis", diagnosisRouter);
    apiRouter.use("/procedures", createProceduresRouter(graph));
    apiRouter.get("/allowedLlms", (_req, res) =>
      res.json(graph.config.allowedLlms || [])
    );

    await new Promise<void>((resolve) =>
      app.listen(port, () => {
        console.log(
          `\n🚀 AetioMed Server running on http://localhost:${port}\n`
        );
        resolve();
      })
    );
  },
});
