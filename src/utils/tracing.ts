import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { getRedisClient } from "./redis.js";

export class TraceBus extends EventEmitter {}

export interface TraceContextPayload {
  requestId: string;
  bus: TraceBus;
}

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

  const persistTrace = (traceEvent: { message: string, data?: any, timestamp: string }) => {
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

export function emitTrace(message: string, data?: any) {
  const store = traceContext.getStore();
  if (!store) {
    return;
  }

  const timestamp = new Date().toISOString();
  store.bus.emit("trace", { message, data, timestamp });
}
