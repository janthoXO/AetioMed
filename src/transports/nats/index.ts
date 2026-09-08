import { connectNats, closeNats } from "./client.js";
import { startCaseGenerationConsumer } from "./cases.handler.js";
import { ConfigSchema } from "./config.js";
import type { GraphAppContext } from "../../core/graph/appContext.js";
import type { CaseGenerationService } from "../../core/caseGenerationService.js";

export interface NatsTransportHandle {
  close(): Promise<void>;
}

/**
 * Start the NATS transport: connects to NATS/JetStream and starts consuming
 * `cases.generate` messages. Constructed explicitly by the composition root
 * (`app.ts`) when the `NATS` flag is set — no loader.
 *
 * Returns a closer rather than registering its own signal handlers (issue
 * 18): shutdown is one sequence owned by the composition root
 * (`src/shutdown.ts`), not scattered per-transport, which is what let a
 * transport's shutdown race a persistence module's and lose.
 */
export async function startNatsTransport(opts: {
  graph: GraphAppContext;
  service: CaseGenerationService;
}): Promise<NatsTransportHandle> {
  const { graph, service } = opts;
  const config = ConfigSchema.parse(process.env);

  console.log("[NATS] Initializing NATS transport...");
  try {
    const connected = await connectNats(config);
    if (!connected) {
      // `closeNats()` is already a no-op with no live connection, so return
      // the same closer shape here as on the connected path rather than
      // `undefined` — the composition root always gets something it can
      // call, on every path.
      return { close: closeNats };
    }
    startCaseGenerationConsumer(graph, service).catch(() => {
      console.error("[NATS] Failed to start case generation consumer");
    });
  } catch (error) {
    console.debug(error);
    console.error("[NATS] Connection failed");
  }

  return { close: closeNats };
}
