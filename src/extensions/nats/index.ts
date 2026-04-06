import { z } from "zod";
import { defineExtension } from "../../core/extension.js";
import { extension as coreExtension } from "../core/index.js";
import { connectNats, closeNats } from "./client.js";
import { startCaseGenerationConsumer } from "./cases.handler.js";

export const extension = defineExtension({
  name: "nats",
  requiredFlags: ["NATS"],
  dependsOn: [coreExtension] as const,
  envSchema: z.object({
    NATS_URL: z.string().optional(),
    NATS_USER: z.string().optional(),
    NATS_PASSWORD: z.string().optional(),
  }),
  async setup() {
    console.log("[nats] Initializing NATS extension...");
    try {
      const connected = await connectNats();
      if (!connected) {
        return;
      }
      startCaseGenerationConsumer().catch(() => {
        console.error("[NATS] Failed to start case generation consumer");
      });
    } catch {
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
