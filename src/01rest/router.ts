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

  apiRouter.get("/hello", async (_req, res) => {
    /* #swagger.responses[200] = {
            content: {
                "application/json": {
                    schema:{
                        type: "object",
                        properties: {
                            msg: {
                                type: "string"
                            }
                        }
                    }
                }           
            }
        }   
    */
    res.status(200).json({ msg: "Hello World" });
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
