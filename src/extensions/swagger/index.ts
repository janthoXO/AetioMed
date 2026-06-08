import { z } from "zod";
import { defineExtension } from "../../core/extension.js";
import { extension as restExtension, apiRouter } from "../rest/index.js";
import swaggerRouter from "./router.js";

export const extension = defineExtension({
  name: "swagger",
  requiredFlags: [],
  dependsOn: [restExtension] as const,
  envSchema: z.object({}),
  async setup() {
    console.log("[swagger] Initializing Swagger UI...");
    apiRouter.use("/", swaggerRouter);
  },
});
