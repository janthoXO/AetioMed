import { z } from "zod";
import { defineExtension } from "../../core/extension.js";
import { getTraceBus, setupTracing } from "./traceManager.js";
import type { TraceEvent } from "./traceManager.js";

export { setupTracing, getTraceBus };
export type { TraceEvent };

function emitToTraceBus(
  jobId: string | undefined,
  type: string,
  payload: unknown
) {
  if (!jobId) return;
  const traceBus = getTraceBus(jobId);
  if (!traceBus) return;
  const event: TraceEvent = {
    jobId,
    type,
    timestamp: new Date().toISOString(),
    payload,
  };
  traceBus.emit("trace", event);
}

export const extension = defineExtension({
  name: "tracing",
  requiredFlags: ["TRACING"],
  dependsOn: [] as const,
  envSchema: z.object({}),
  async setup({ bus }) {
    console.log("[tracing] Initializing Tracing extension...");

    bus.on("Node Started", ({ jobId, node, timestamp }) => {
      emitToTraceBus(jobId, "Node Started", { node, timestamp });
    });

    bus.on("Node Completed", ({ jobId, node, result, timestamp }) => {
      emitToTraceBus(jobId, "Node Completed", { node, result, timestamp });
    });

    bus.on("Generation Completed", ({ jobId, case: generatedCase }) => {
      emitToTraceBus(jobId, "Generation Completed", { case: generatedCase });
    });

    bus.on("Generation Failure", ({ jobId, error }) => {
      const message = error instanceof Error ? error.message : String(error);
      emitToTraceBus(jobId, "Generation Failure", { message });
    });

    bus.on("Generation Cancelled", ({ jobId }) => {
      emitToTraceBus(jobId, "Generation Cancelled", {});
    });
  },
});
