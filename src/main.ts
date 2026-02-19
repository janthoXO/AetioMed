import { initRouter } from "./01rest/router.js";
import { config } from "./config.js";
import { initNats, closeNats } from "./01nats/index.js";
import { initProcedureVectorStore } from "./03repo/procedure/vectorStore.js";

console.log("Environment variables loaded.", config);

// Initialize NATS
initNats().catch(console.error);

// Initialize procedure vector store (embeds predefined procedures)
initProcedureVectorStore().catch(console.error);

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
