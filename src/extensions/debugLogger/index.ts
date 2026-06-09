import { defineExtension } from "../../core/extension.js";
import { EnvSchema } from "@/config.js";

export const extension = defineExtension({
  name: "debugLogger",
  requiredFlags: ["DEBUG"],
  dependsOn: [] as const,
  envSchema: EnvSchema,
  async setup({ config, bus }) {
    if (!config.features.has("DEBUG")) {
      return;
    }

    console.log("[debugLogger] Initializing DebugLogger extension...");

    bus.onAny((name, payload) => {
      if (name === "Generation Log") {
        const { msg, logLevel } = payload as { msg: string; logLevel: string };
        switch (logLevel) {
          case "error":
            console.error(`[bus] ${name}`, msg);
            break;
          case "warn":
            console.warn(`[bus] ${name}`, msg);
            break;
          default:
            console.info(`[bus] ${name}`, msg);
        }
      } else if (name === "Generation Failure") {
        const { error } = payload as { error: unknown };
        const msg =
          error instanceof Error ? error.stack || error.message : String(error);
        console.error(`[bus] ${name}`, msg);
      } else {
        console.log(`[bus] ${name}`, payload);
      }
    });
  },
});
