import { initRouter } from "./rest/router.js";
import { config } from "./utils/config.js";
import { initNats, closeNats } from "./nats/index.js";

console.log("Environment variables loaded.", config);

// Initialize NATS
initNats().catch(console.error);

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
