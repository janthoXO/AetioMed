import { defineExtension } from "../../core/extension.js";
import { extension as coreExtension } from "../core/index.js";
import { connectNats, closeNats } from "./client.js";
import { startCaseGenerationConsumer } from "./cases.handler.js";
import { ConfigSchema } from "./config.js";

export const extension = defineExtension({
  name: "nats",
  requiredFlags: ["NATS"],
  dependsOn: [coreExtension] as const,
  envSchema: ConfigSchema,
  async setup({ config }) {
    console.log("[NATS] Initializing NATS extension...");
    try {
      const connected = await connectNats(config);
      if (!connected) {
        return;
      }
      startCaseGenerationConsumer().catch(() => {
        console.error("[NATS] Failed to start case generation consumer");
      });
    } catch (error) {
      console.debug(error);
      console.error("[NATS] Connection failed");
    }

    // Graceful shutdown handling
    const shutdown = async () => {
      console.log("[NATS] Shutting down NATS...");
      await closeNats();
    };

    process.once("SIGINT", async () => {
      await shutdown();
      process.exit(0);
    });

    process.once("SIGTERM", async () => {
      await shutdown();
      process.exit(0);
    });
  },
});
