import "dotenv/config";
import { createApp } from "./core/app.js";

createApp().catch((err) => {
  console.error("[fatal]", err.message);
  process.exit(1);
});
