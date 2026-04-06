import { z } from "zod";
import { defineExtension } from "../../core/extension.js";
import { extension as coreExtension } from "../core/index.js";
import { getRedisClient } from "../core/03repo/redis.js";
import persistencyRouter from "./router.js";

export const extension = defineExtension({
  name: "persistency",
  requiredFlags: ["PERSISTENCY"],
  dependsOn: [coreExtension] as const,
  envSchema: z.object({
    REDIS_URL: z.string().optional(),
  }),
  async setup({ bus, router }) {
    console.log("[persistency] Initializing Persistency extension...");

    bus.on("Generation Completed", ({ case: generatedCase }) => {
      getRedisClient().then((redis) => {
        if (!redis) {
          return;
        }

        // make key with time first to make it sortable
        const caseKey = `case:${new Date().getTime()}-${crypto.randomUUID()}`;
        redis.set(caseKey, JSON.stringify(generatedCase)).catch((err) => {
          console.error("[persistency] Error saving case to Redis:", err);
        });
      });
    });

    router.use("/", persistencyRouter);
  },
});
