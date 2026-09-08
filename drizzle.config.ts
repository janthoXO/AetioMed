import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/core/graph/persistence/schema.ts",
  out: "./drizzle",
});
