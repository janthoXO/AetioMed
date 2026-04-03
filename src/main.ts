import { config } from "./config.js";
import { initNats } from "./nats/index.js";
import { initPersistency } from "./persistency/index.js";
import { initTracing } from "./tracing/index.js";
import express from "express";
import morgan from "morgan";
import cors from "cors";
import coreRouter from "./core/01rest/index.js";
import swaggerRouter from "./swagger/router.js";
import traceRouter from "./tracing/router.js";
import persistencyRouter from "./persistency/router.js";
import { initDebugLogger } from "./debugLogger/index.js";

console.log("Environment variables loaded.", JSON.stringify(config, null, 2));

const apiRouter = express.Router();

apiRouter.get("/health", async (_req, res) => {
  /* #swagger.responses[200] = {
            content: {
                "application/json": {
                    schema:{
                        type: "object",
                        properties: {
                            status: {
                                type: "string"
                            }
                        }
                    }
                }           
            }
        }   
    */
  res.status(200).json({ status: "OK" });
});

apiRouter.get("/features", async (_req, res) => {
  /* #swagger.responses[200] = {
            content: {
                "application/json": {
                    schema:{
                        type: "object",
                        properties: {
                            features: {
                                type: "array",
                                items: {
                                    type: "string"
                                }
                            }
                        }
                    }
                }           
            }
        }   
    */
  res.status(200).json({ features: Array.from(config.features) });
});

apiRouter.use("/", coreRouter);

const app = express();

app.use("/docs", swaggerRouter);

app.use(express.json());
if (config.debug === true) {
  app.use(cors());
  app.use(morgan("dev")); // for logging HTTP requests in debug mode
  initDebugLogger();
}

// Initialize Features
if (config.features.has("NATS")) {
  initNats();
}

if (config.features.has("PERSISTENCY")) {
  initPersistency();
  apiRouter.use("/", persistencyRouter);
}

if (config.features.has("TRACING")) {
  initTracing();
  apiRouter.use("/", traceRouter);
}

app.use("/api", apiRouter);
app.listen(config.port, () => {
  console.log(`[REST] Server is running on port ${config.port}`);
});
