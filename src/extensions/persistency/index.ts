import { z } from "zod";
import { defineExtension } from "../../core/extension.js";
import { extension as restExtension, apiRouter } from "../rest/index.js";
import { getRedisClient } from "@/extensions/persistency/redis.js";
import persistencyRouter from "./router.js";

export const extension = defineExtension({
  name: "persistency",
  requiredFlags: ["PERSISTENCY"],
  dependsOn: [restExtension] as const,
  envSchema: z.object({
    REDIS_URL: z.string().optional(),
  }),
  async setup({ bus }) {
    console.log("[persistency] Initializing Persistency extension...");

    bus.on("Generation Completed", ({ case: generatedCase }) => {
      getRedisClient().then((redis) => {
        if (!redis) {
          return;
        }

        const caseKey = `case:${new Date().getTime()}-${crypto.randomUUID()}`;
        redis.set(caseKey, JSON.stringify(generatedCase)).catch((err) => {
          console.error("[persistency] Error saving case to Redis:", err);
        });
      });
    });

    apiRouter.use("/", persistencyRouter);
  },
});
