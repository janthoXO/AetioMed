import express from "express";
import swaggerUi from "swagger-ui-express";
import swaggerDocument from "./swagger-output.json" with { type: "json" };
import morgan from "morgan";

import casesRouter from "./cases.router.js";
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

  apiRouter.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

  const app = express();

  app.use(express.json());
  if (config.DEBUG === true) {
    app.use(morgan("dev"));
  }

  app.use("/api", apiRouter);
  app.listen(config.PORT, () => {
    console.log(`[REST] Server is running on port ${config.PORT}`);
  });

  return Promise.resolve();
}
