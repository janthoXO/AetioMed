import { connectNats, closeNats } from "./client.js";
import { startCaseGenerationConsumer } from "./cases.handler.js";
import { ConfigSchema } from "./config.js";
import type { GraphAppContext } from "../../core/graph/appContext.js";
import type { CaseGenerationService } from "../../core/caseGenerationService.js";

/**
 * Start the NATS transport: connects to NATS/JetStream and starts consuming
 * `cases.generate` messages. Constructed explicitly by the composition root
 * (`app.ts`) when the `NATS` flag is set — no loader.
 */
export async function startNatsTransport(opts: {
  graph: GraphAppContext;
  service: CaseGenerationService;
}): Promise<void> {
  const { graph, service } = opts;
  const config = ConfigSchema.parse(process.env);

  console.log("[NATS] Initializing NATS transport...");
  try {
    const connected = await connectNats(config);
    if (!connected) {
      return;
    }
    startCaseGenerationConsumer(graph, service).catch(() => {
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
}
