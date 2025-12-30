import express from "express";
import swaggerUi from "swagger-ui-express";
import swaggerDocument from "./swagger-output.json" with { type: "json" };
import morgan from "morgan";

import casesRouter from "./cases.router.js";
import { config } from "@/utils/config.js";

export function initRouter(): Promise<void> {
  const apiRouter = express.Router();

  apiRouter.get("/hello", async (_req, res) => {
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
    console.log(`Server is running on port ${config.PORT}`);
  });

  return Promise.resolve();
}
