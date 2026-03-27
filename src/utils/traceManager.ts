import { EventEmitter } from "node:events";
import { getRedisClient } from "./redis.js";
import z from "zod";

export class TraceBus extends EventEmitter {}

export const TraceEventSchema = z.object({
  message: z.string(),
  data: z.any().optional(),
  timestamp: z.iso.time().default(() => new Date().toISOString()),
  category: z.enum(["info", "error", "warn"]).default("info"),
});

export type TraceEvent = z.infer<typeof TraceEventSchema>;

const activeBuses = new Map<string, TraceBus>();

export function getTraceBus(requestId: string): TraceBus | undefined {
  return activeBuses.get(requestId);
}

export const TraceUtilsSchema = z.object({
  traceId: z.string(),
  emitTrace: z.function({
    input: [
      TraceEventSchema.shape.message,
      TraceEventSchema.omit({ message: true }).partial().optional(),
    ],
    output: z.void(),
  }),
});

export type TraceUtils = z.infer<typeof TraceUtilsSchema>;

export function setupTracing(traceId: string): {
  traceUtils: TraceUtils;
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
        if (redis) {
          const key = `traces:${traceId}`;
          const serializedTrace = JSON.stringify(traceEvent);
          redis
            .rPush(key, serializedTrace)
            .then(() => {
              // Set an expiration of 1 day to clean up old traces automatically
              redis.expire(key, 86400);
            })
            .catch(console.error);
        }
      })
      .catch(console.error);
  };

  bus.on("trace", persistTrace);

  const emitTrace: TraceUtils["emitTrace"] = (message, event?) => {
    const traceEvent: TraceEvent = {
      message: message,
      timestamp: event?.timestamp ?? new Date().toISOString(),
      category: event?.category ?? "info",
      data: event?.data,
    };

    bus.emit("trace", traceEvent);
  };

  return {
    traceUtils: { traceId, emitTrace },
    cleanup,
  };
}
