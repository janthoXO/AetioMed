import { EventEmitter } from "node:events";
import { getRedisClient } from "@/core/03repo/redis.js";
import z from "zod";
import { config } from "@/config.js";

export class TraceBus extends EventEmitter {}

export const TraceEventSchema = z.object({
  message: z.string(),
  data: z.any().optional(),
  timestamp: z.iso.time().default(() => new Date().toISOString()),
  category: z.enum(["info", "error", "warn"]).default("info"),
});

export type TraceEvent = z.infer<typeof TraceEventSchema>;

const activeBuses = new Map<string, TraceBus>();

export function getTraceBus(traceId: string): TraceBus | undefined {
  return activeBuses.get(traceId);
}

export function setupTracing(traceId: string): {
  cleanup: () => void;
} {
  const bus = new TraceBus();
  activeBuses.set(traceId, bus);

  const cleanup = () => {
    // Wait a bit before cleaning up to ensure all events are sent
    setTimeout(() => {
      activeBuses.delete(traceId);
      bus.removeAllListeners();
    }, 10000);
  };

  const persistTrace = (traceEvent: TraceEvent) => {
    getRedisClient()
      .then((redis) => {
        if (!redis) {
          return;
        }

        const key = `traces:${traceId}`;
        const serializedTrace = JSON.stringify(traceEvent);
        redis
          .rPush(key, serializedTrace)
          .then(() => {
            // Set an expiration of 1 day to clean up old traces automatically
            redis.expire(key, 86400);
          })
          .catch(console.error);
      })
      .catch(console.error);
  };

  if (config.features.has("PERSISTENCY")) {
    bus.on("trace", persistTrace);
  }

  return {
    cleanup,
  };
}
