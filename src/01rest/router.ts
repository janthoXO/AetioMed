import express from "express";
import swaggerUi from "swagger-ui-express";
import swaggerDocument from "./swagger-output.json" with { type: "json" };
import morgan from "morgan";
import cors from "cors";

import casesRouter from "./cases.router.js";
import diseasesRouter from "./diseases.router.js";
import proceduresRouter from "./procedures.router.js";
import { config } from "@/config.js";

export function initRouter(): Promise<void> {
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
    const features = [];
    if (config.nats) features.push("nats");
    if (config.redis) features.push("tracePersistence");
    if (!config.llm) features.push("customLLM");
    res.status(200).json({ features });
  });

  apiRouter.use("/cases", casesRouter);
  apiRouter.use("/diseases", diseasesRouter);
  apiRouter.use("/procedures", proceduresRouter);

  apiRouter.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

  const app = express();

  app.use(express.json());
  if (config.debug === true) {
    app.use(cors());
    app.use(morgan("dev"));
  }

  app.use("/api", apiRouter);
  app.listen(config.port, () => {
    console.log(`[REST] Server is running on port ${config.port}`);
  });

  return Promise.resolve();
}
