import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/core/graph/03repo/schema.ts",
  out: "./drizzle",
});
