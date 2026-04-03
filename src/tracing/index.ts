import {
  eventBus,
  type GenerationFailureEventPayload,
  type GenerationLogEventPayload,
} from "@/core/eventBus/index.js";
import { getTraceBus } from "@/tracing/traceManager.js";
import { getRequestContext } from "@/core/utils/context.js";
import traceRouter from "./router.js";
import { registry } from "@/extension/registry.js";
import { config } from "@/config.js";

async function onGenerationLog({ msg, logLevel }: GenerationLogEventPayload) {
  const context = getRequestContext();
  const traceId = context?.traceId;
  if (!traceId) return;

  // Emit via active trace bus if one corresponds to the current traceId
  const traceBus = getTraceBus(traceId);
  if (traceBus) {
    traceBus.emit("trace", {
      message: msg,
      category: logLevel,
    });
  }
}

async function onGenerationFailure({ error }: GenerationFailureEventPayload) {
  const context = getRequestContext();
  const traceId = context?.traceId;
  if (!traceId) return;

  const msg = error instanceof Error ? error.message : String(error);

  // Emit via active trace bus if one corresponds to the current traceId
  const traceBus = getTraceBus(traceId);
  if (traceBus) {
    traceBus.emit("trace", {
      message: msg,
      category: "error",
      data: error,
    });
  }
}

registry.register({
  name: "Tracing",
  initialize(router) {
    if (!config.features.has("TRACING")) {
      return;
    }

    eventBus.on("Generation Log", onGenerationLog);
    eventBus.on("Generation Failure", onGenerationFailure);

    router.use("/", traceRouter);
  },
});
