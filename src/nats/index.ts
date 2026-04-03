import { connectNats, closeNats } from "./client.js";
import { startCaseGenerationConsumer } from "./cases.handler.js";
import { registry } from "@/extension/registry.js";

registry.register({
  name: "Nats",
  flags: new Set(["NATS"]),
  async initialize() {
    try {
      const connected = await connectNats();
      if (!connected) {
        return;
      }

      // Start consumers (without awaiting the loop so initNats returns)
      // Actually startCaseGenerationConsumer has a 'for await' loop so it blocks!
      // We should run it in background.
      startCaseGenerationConsumer().catch(() => {
        console.error("[NATS] Failed to start case generation consumer");
      });
    } catch {
      console.error("[NATS] Connection failed");
    }

    // Graceful shutdown
    process.on("SIGINT", async () => {
      console.log("SIGINT received. Shutting down...");
      await closeNats();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      console.log("SIGTERM received. Shutting down...");
      await closeNats();
      process.exit(0);
    });
  },
});
