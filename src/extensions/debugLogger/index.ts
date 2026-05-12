import { defineExtension } from "../../core/extension.js";
import { extension as coreExtension } from "../core/index.js";
import { EnvSchema } from "@/config.js";

export const extension = defineExtension({
  name: "debugLogger",
  requiredFlags: ["DEBUG"],
  dependsOn: [coreExtension] as const,
  envSchema: EnvSchema,
  async setup({ config, bus }) {
    if (!config.features.has("DEBUG")) {
      return;
    }

    console.log("[debugLogger] Initializing DebugLogger extension...");

    bus.on("Generation Log", async ({ msg, logLevel }) => {
      switch (logLevel) {
        case "error":
          console.error(msg);
          break;
        case "warn":
          console.warn(msg);
          break;
        case "info":
          console.info(msg);
          break;
      }
    });

    bus.on("Generation Failure", async ({ error }) => {
      const msg =
        error instanceof Error ? error.stack || error.message : String(error);
      console.error(msg);
    });
  },
});
