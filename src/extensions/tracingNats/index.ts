import { defineExtension } from "../../core/extension.js";
import { extension as tracingExtension } from "../tracing/index.js";
import { extension as natsExtension } from "../nats/index.js";
import { getJetStreamClient } from "../nats/client.js";
import { headers } from "@nats-io/transport-node";
import type { TraceEvent } from "../tracing/traceManager.js";

async function publishTrace(jobId: string, type: string, payload: unknown) {
  try {
    const js = getJetStreamClient();
    const hdrs = headers();
    hdrs.set("Job-Id", jobId);
    const event: TraceEvent = {
      jobId,
      type,
      timestamp: new Date().toISOString(),
      payload,
    };
    await js.publish(`traces.${jobId}`, JSON.stringify(event), {
      headers: hdrs,
    });
  } catch (err) {
    console.error("[tracingNats] Failed to publish trace:", err);
  }
}

export const extension = defineExtension({
  name: "tracingNats",
  dependsOn: [tracingExtension, natsExtension] as const,
  async setup({ bus }) {
    console.log("[tracingNats] Initializing TracingNats extension...");

    bus.on("Node Started", ({ jobId, node, timestamp }) => {
      if (!jobId) return;
      publishTrace(jobId, "Node Started", { node, timestamp });
    });

    bus.on("Node Completed", ({ jobId, node, result, timestamp }) => {
      if (!jobId) return;
      publishTrace(jobId, "Node Completed", { node, result, timestamp });
    });

    bus.on("Generation Completed", ({ jobId, case: generatedCase }) => {
      if (!jobId) return;
      publishTrace(jobId, "Generation Completed", { case: generatedCase });
    });

    bus.on("Generation Failure", ({ jobId, error }) => {
      if (!jobId) return;
      const message = error instanceof Error ? error.message : String(error);
      publishTrace(jobId, "Generation Failure", { message });
    });
  },
});
