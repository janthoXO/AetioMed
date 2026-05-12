import { defineExtension } from "../../core/extension.js";
import type { EventBus } from "../../core/event-bus.js";

// We bring in all the original app logic routers here
import apiRouter from "./01rest/index.js";
import type { Case } from "./models/Case.js";
import { ConfigSchema, type Config } from "./config.js";

declare module "../../core/event-bus.js" {
  interface EventMap {
    "Generation Completed": { case: Case; additionalData?: object };
    "Generation Failure": { error: Error; additionalData?: object };
    "Generation Log": {
      msg: string;
      logLevel: "info" | "warn" | "error";
      timestamp: string;
      additionalData?: object;
    };
    // Ensure tracing hooks are available to the core system globally if it uses them directly
  }
}

export let config: Config;
export let bus: EventBus;

export const extension = defineExtension({
  name: "core",
  requiredFlags: [],
  envSchema: ConfigSchema,

  async setup({ config: parsedConfig, router, bus: extensionBus }) {
    bus = extensionBus;
    config = parsedConfig;

    // Mount the core REST routes to `/api/`
    // They are standard express routes
    router.use("/", apiRouter);

    console.log(
      `[core] Starting core extension with ${parsedConfig.allowedLlms ? "dynamic LLMs" : parsedConfig.llm?.provider + "/" + parsedConfig.llm?.model} configuration.`
    );
  },
});
