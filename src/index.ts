import "dotenv/config";
import { createApp } from "./core/app.js";
import { allExtensions } from "./extensions/_registry.js"; // generated

createApp(allExtensions).catch((err) => {
  console.error("[fatal]", err.message);
  process.exit(1);
});
