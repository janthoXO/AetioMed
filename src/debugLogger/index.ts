import { config } from "@/config.js";
import {
  eventBus,
  type GenerationFailureEventPayload,
  type GenerationLogEventPayload,
} from "@/core/eventBus/index.js";
import { registry } from "@/extension/registry.js";

async function onGenerationLog({ msg, logLevel }: GenerationLogEventPayload) {
  switch (logLevel) {
    case "error":
      console.error(msg);
      break;
    case "warn":
      console.warn(msg);
      break;
    case "info":
      console.info(msg);
      break;
  }
}

async function onGenerationFailure({ error }: GenerationFailureEventPayload) {
  const msg =
    error instanceof Error ? error.stack || error.message : String(error);
  console.error(msg);
}

registry.register({
  name: "DebugLogger",
  flags: new Set(),
  initialize() {
    if (!config.debug) {
      return;
    }

    eventBus.on("Generation Log", onGenerationLog);
    eventBus.on("Generation Failure", onGenerationFailure);
  },
});
