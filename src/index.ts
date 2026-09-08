import "dotenv/config";
import { createApp } from "./core/app.js";
import { installSignalHandlers } from "./shutdown.js";

createApp()
  .then(({ shutdown }) => installSignalHandlers(shutdown))
  .catch((err) => {
    console.error("[fatal]", err.message);
    process.exit(1);
  });
