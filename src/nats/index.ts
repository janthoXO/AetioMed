import { connectNats, closeNats } from "./client.js";
import { startCaseGenerationConsumer } from "./cases.handler.js";

export async function initNats() {
  try {
    await connectNats();
    // Start consumers (without awaiting the loop so initNats returns)
    // Actually startCaseGenerationConsumer has a 'for await' loop so it blocks!
    // We should run it in background.
    startCaseGenerationConsumer().catch(() => {
      console.error("[NATS] Failed to start case generation consumer");
    });
  } catch {
    console.error("[NATS] Connection failed");
  }
}

export { closeNats };
