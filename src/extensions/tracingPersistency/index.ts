import { z } from "zod";
import { defineExtension } from "../../core/extension.js";
import { extension as restExtension, apiRouter } from "../rest/index.js";
import { extension as persistencyExtension } from "../persistency/index.js";
import { extension as tracingExtension } from "../tracing/index.js";
import { getRedisClient } from "@/extensions/persistency/redis.js";
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
  requiredFlags: [],
  dependsOn: [restExtension, persistencyExtension, tracingExtension] as const,
  envSchema: z.object({}),
  async setup({ bus }) {
    console.log(
      "[tracingPersistency] Initializing Tracing Persistency extension..."
    );

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
              redis.expire(key, 86400);
            })
            .catch(console.error);
        })
        .catch(console.error);
    });

    apiRouter.use("/", tracingPersistencyRouter);
  },
});
