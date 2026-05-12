import express from "express";
import { z } from "zod";
import { EventBus } from "./event-bus.js";
import { loadExtensions } from "./loader.js";
import type { AnyExt } from "./extension.js";
import cors from "cors";
import morgan from "morgan";

// The framework's own env slice — separate from any extension's schema
const AppEnvSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3030),
    FEATURES: z.string().default(""), // e.g. "NATS,PERSISTENCY,TRACING"
  })
  .transform((env) => {
    return {
      features: env.FEATURES.split(",")
        .map((f) => f.trim())
        .filter(Boolean),
      port: env.PORT,
    };
  });

export async function createApp(extensions: readonly AnyExt[]) {
  const env = AppEnvSchema.parse(process.env);

  console.log(`[app] Feature flags: ${env.features.join(", ") || "none"}]`);

  const app = express();
  app.use(express.json());

  if (env.features.includes("DEBUG")) {
    app.use(cors());
    app.use(morgan("dev"));
  }

  const apiRouter = express.Router();
  apiRouter.get("/health", (_req, res) =>
    res.json({ status: "ok", timestamp: new Date().toISOString() })
  );
  apiRouter.get("/features", (_req, res) => res.json(env.features));
  app.use("/api", apiRouter);

  const eventBus = new EventBus();
  await loadExtensions({
    extensions: [...extensions],
    enabledFlags: new Set(env.features),
    bus: eventBus,
    apiRouter,
  });

  return new Promise<{ app: express.Express; bus: EventBus }>((resolve) => {
    app.listen(env.port, () => {
      console.log(
        `\n🚀 AetioMed Server running on http://localhost:${env.port}\n`
      );
      resolve({ app, bus: eventBus });
    });
  });
}
