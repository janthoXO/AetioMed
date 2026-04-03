import { createClient, type RedisClientType } from "redis";
import { persistencyConfig } from "@/persistency/config.js";

let redisClientPromise: Promise<RedisClientType | null> | null = null;

export function getRedisClient(): Promise<RedisClientType | null> {
  if (redisClientPromise) {
    return redisClientPromise;
  }

  redisClientPromise = (async () => {
    const client = createClient({ url: persistencyConfig.url });

    await client.connect();
    console.log("[Redis] Connected to Redis successfully.");
    return client as RedisClientType;
  })().catch(() => {
    console.error("[Redis] Failed to connect to Redis");
    return null;
  });

  return redisClientPromise;
}
