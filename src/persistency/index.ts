import {
  eventBus,
  type GenerationCompletedEventPayload,
} from "@/core/eventBus/index.js";
import { getRedisClient } from "@/core/03repo/redis.js";
import persistencyRouter from "./router.js";
import { registry } from "@/extension/registry.js";
import { config } from "@/config.js";

function onGenerationCompleted({
  case: generatedCase,
}: GenerationCompletedEventPayload) {
  getRedisClient().then((redis) => {
    if (!redis) {
      return;
    }

    // make key with time first to make it sortable
    const caseKey = `case:${new Date().getTime()}-${crypto.randomUUID()}`;
    redis.set(caseKey, JSON.stringify(generatedCase)).catch((err) => {
      console.error("Error saving case to Redis:", err);
    });
  });
}

export function initPersistency() {
  eventBus.on("Generation Completed", onGenerationCompleted);
}

registry.register({
  name: "Persistency",
  initialize(router) {
    if (!config.features.has("PERSISTENCY")) {
      return;
    }

    eventBus.on("Generation Completed", onGenerationCompleted);
    router.use("/", persistencyRouter);
  },
});
