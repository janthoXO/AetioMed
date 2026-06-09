import { z } from "zod";
import { defineExtension } from "../../core/extension.js";
import { extension as restExtension, apiRouter } from "../rest/index.js";
import { extension as persistencyExtension } from "../persistency/index.js";
import { extension as tracingExtension } from "../tracing/index.js";
import { getRedisClient } from "@/extensions/persistency/redis.js";
import tracingPersistencyRouter from "./router.js";

declare module "../../core/event-bus.js" {
  interface EventMap {
    "Trace Completed": { jobId: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "Trace Persistence Request": { jobId: string; traceEvent: any };
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

    bus.on("Trace Persistence Request", ({ jobId, traceEvent }) => {
      getRedisClient()
        .then((redis) => {
          if (!redis) {
            return;
          }

          const key = `traces:${jobId}`;
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
