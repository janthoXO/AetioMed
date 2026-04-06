import { z } from "zod";
import { defineExtension } from "../../core/extension.js";
import { extension as coreExtension } from "../core/index.js";
import { extension as persistencyExtension } from "../persistency/index.js";
import { extension as tracingExtension } from "../tracing/index.js";
import { getRedisClient } from "../core/03repo/redis.js";
import tracingPersistencyRouter from "./router.js";

declare module "../../core/event-bus.js" {
  interface EventMap {
    "Trace Completed": { traceId: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "Trace Persistence Request": { traceId: string; traceEvent: any };
  }
}

export const extension = defineExtension({
  name: "tracingPersistency",
  requiredFlags: [], // Doesn't need a specific flag, but it explicitly depends on tracing and persistency extensions being loaded
  dependsOn: [coreExtension, persistencyExtension, tracingExtension] as const,
  envSchema: z.object({}),
  async setup({ bus, router }) {
    console.log(
      "[tracingPersistency] Initializing Tracing Persistency extension..."
    );

    // Listen to Trace Persistence Requests from tracing manager
    bus.on("Trace Persistence Request", ({ traceId, traceEvent }) => {
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
    });

    // Tracing persistency specific router for `GET /traces` and `GET /traces/:id` from Redis
    router.use("/", tracingPersistencyRouter);
  },
});
