import { initRouter } from "./rest/router.js";
import { config } from "./utils/config.js";

console.log("Environment variables loaded.", config);
initRouter();
