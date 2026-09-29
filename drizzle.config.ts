import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/adapters/persistence/schema.ts",
  out: "./drizzle",
});
