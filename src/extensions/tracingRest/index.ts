import { defineExtension } from "../../core/extension.js";
import { extension as tracingExtension } from "../tracing/index.js";
import { extension as restExtension, apiRouter } from "../rest/index.js";
import traceRouter from "./router.js";

export const extension = defineExtension({
  name: "tracingRest",
  dependsOn: [tracingExtension, restExtension] as const,
  async setup() {
    console.log("[tracingRest] Initializing TracingRest extension...");
    apiRouter.use("/", traceRouter);
  },
});
