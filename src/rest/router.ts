import express from "express";
import swaggerUi from "swagger-ui-express";
import swaggerDocument from "./swagger-output.json" with { type: "json" };
import morgan from "morgan";

import casesRouter from "./cases.router.js";

export function initRouter(): Promise<void> {
  const apiRouter = express.Router();

  apiRouter.use("/cases", casesRouter);

  apiRouter.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

  const app = express();

  app.use(express.json());
  if (process.env.DEBUG === "true") {
    app.use(morgan("dev"));
  }

  app.use("/api", apiRouter);
  app.listen(process.env.PORT, () => {
    console.log(`Server is running on port ${process.env.PORT}`);
  });

  return Promise.resolve();
}
