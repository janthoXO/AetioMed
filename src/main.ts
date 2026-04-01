import { initRouter } from "./01rest/router.js";
import { config } from "./config.js";
import { initNats, closeNats } from "./01nats/index.js";
import { getRedisClient } from "./utils/redis.js";

console.log("Environment variables loaded.", JSON.stringify(config, null, 2));

// Initialize NATS
initNats().catch(console.error);

// Test if redis is available at startup
getRedisClient().catch(console.error);

initRouter();

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("SIGINT received. Shutting down...");
  await closeNats();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("SIGTERM received. Shutting down...");
  await closeNats();
  process.exit(0);
});
