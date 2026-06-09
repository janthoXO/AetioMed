import { defineExtension } from "../../core/extension.js";
import { extension as tracingExtension } from "../tracing/index.js";
import { extension as natsExtension } from "../nats/index.js";
import { getNatsConnection } from "../nats/client.js";

function publishTrace(
  jobId: string,
  type: string,
  payload: Record<string, unknown>
) {
  try {
    const nc = getNatsConnection();
    const event = { jobId, type, payload };
    nc.publish(`cases.traces.${jobId}`, JSON.stringify(event));
  } catch (err) {
    console.error("[tracingNats] Failed to publish trace:", err);
  }
}

export const extension = defineExtension({
  name: "tracingNats",
  dependsOn: [tracingExtension, natsExtension] as const,
  async setup({ bus }) {
    console.log("[tracingNats] Initializing TracingNats extension...");

    bus.on("Node Started", ({ jobId, node, label }) => {
      if (!jobId) return;
      publishTrace(jobId, "Node Started", { node, label: label ?? node });
    });

    bus.on("Node Completed", ({ jobId, node, result }) => {
      if (!jobId) return;
      publishTrace(jobId, "Node Completed", { node, result });
    });

    bus.on("Generation Completed", ({ jobId, case: generatedCase }) => {
      if (!jobId) return;
      publishTrace(jobId, "Generation Completed", {
        case: generatedCase as Record<string, unknown>,
      });
    });

    bus.on("Generation Failure", ({ jobId, error }) => {
      if (!jobId) return;
      const message = error instanceof Error ? error.message : String(error);
      publishTrace(jobId, "Generation Failure", { message });
    });

    bus.on("Generation Cancelled", ({ jobId }) => {
      if (!jobId) return;
      publishTrace(jobId, "Generation Cancelled", {
        message: "Generation was cancelled",
      });
    });
  },
});
