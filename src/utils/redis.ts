import { createClient, type RedisClientType } from "redis";
import { config } from "../config.js";

let redisClientPromise: Promise<RedisClientType | null> | null = null;

export function getRedisClient(): Promise<RedisClientType | null> {
  if (redisClientPromise) {
    return redisClientPromise;
  }

  redisClientPromise = (async () => {
    if (!config.REDIS_URL) {
      console.log(
        "[Redis] REDIS_URL not configured. Traces will not be persisted."
      );
      return null;
    }

    try {
      const client = createClient({ url: config.REDIS_URL });

      // Non-blocking error handler, so we don't crash
      client.on("error", (err) => {
        console.error("[Redis] Client error:", err);
      });

      await client.connect();
      console.log("[Redis] Connected to Redis successfully.");
      return client as RedisClientType;
    } catch (error) {
      console.warn(
        `[Redis] Failed to connect to Redis at ${config.REDIS_URL}. Traces will not be persisted.`,
        error
      );
      return null;
    }
  })();

  return redisClientPromise;
}
