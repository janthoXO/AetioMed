import { createClient, type RedisClientType } from "redis";
import { config } from "../config.js";

let redisClientPromise: Promise<RedisClientType | null> | null = null;

export function getRedisClient(): Promise<RedisClientType | null> {
  if (redisClientPromise) {
    return redisClientPromise;
  }

  redisClientPromise = (async () => {
    if (!config.redis?.url) {
      console.log(
        "[Redis] REDIS_URL not configured. Traces will not be persisted."
      );
      return null;
    }

    const client = createClient({ url: config.redis?.url });

    await client.connect();
    console.log("[Redis] Connected to Redis successfully.");
    return client as RedisClientType;
  })().catch(() => {
    console.error("[Redis] Failed to connect to Redis");
    return null;
  });

  return redisClientPromise;
}
