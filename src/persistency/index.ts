import {
  eventBus,
  type GenerationCompletedEventPayload,
} from "@/core/eventBus/index.js";
import { getRedisClient } from "@/core/03repo/redis.js";

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
