import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { getRedisClient } from "./redis.js";
import z from "zod";

export class TraceBus extends EventEmitter {}

export interface TraceContextPayload {
  requestId: string;
  bus: TraceBus;
}

export const TraceEventSchema = z.object({
  message: z.string(),
  data: z.any().optional(),
  timestamp: z.iso.time().default(() => new Date().toISOString()),
  category: z.enum(["info", "error", "warn"]).default("info"),
});

export type TraceEvent = z.infer<typeof TraceEventSchema>;

export const traceContext = new AsyncLocalStorage<TraceContextPayload>();

const activeBuses = new Map<string, TraceBus>();

export function runWithTracing<T>(requestId: string, fn: () => T): T {
  const bus = new TraceBus();
  activeBuses.set(requestId, bus);

  const cleanup = () => {
    // Wait a bit before cleaning up to ensure all events are sent
    setTimeout(() => {
      activeBuses.delete(requestId);
      bus.removeAllListeners();
    }, 10000);
  };

  const persistTrace = (traceEvent: TraceEvent) => {
    getRedisClient()
      .then((redis) => {
        if (redis) {
          const key = `traces:${requestId}`;
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

  try {
    const result = traceContext.run({ requestId, bus }, fn);
    if (result instanceof Promise) {
      result.finally(cleanup);
    } else {
      cleanup();
    }
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function getTraceBus(requestId: string): TraceBus | undefined {
  return activeBuses.get(requestId);
}

export function emitTrace(
  message: string,
  traceConfig?: Partial<Omit<TraceEvent, "message">>
): void {
  const store = traceContext.getStore();
  if (!store) {
    return;
  }

  const traceEvent: TraceEvent = {
    message,
    timestamp: traceConfig?.timestamp ?? new Date().toISOString(),
    category: traceConfig?.category ?? "info",
    data: traceConfig?.data,
  };

  store.bus.emit("trace", traceEvent);
  switch (traceEvent.category) {
    case "error":
      console.error(`[Trace] ${traceEvent.message}`, traceEvent.data);
      break;
    case "warn":
      console.warn(`[Trace] ${traceEvent.message}`, traceEvent.data);
      break;
    default:
      console.debug(`[Trace] ${traceEvent.message}`, traceEvent.data);
  }
}
