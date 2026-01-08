import dotenv from "dotenv";
import z from "zod";

dotenv.config();

const ConfigSchema = z.object({
  PORT: z.coerce.number().default(3030),
  DEBUG: z.coerce.boolean().default(false),
  LLM_FORMAT: z.enum(["TOON", "JSON"]).default("JSON"),

  // NATS
  NATS_URL: z.string().default("nats://localhost:4222"),
  NATS_USER: z.string().default("nats"),
  NATS_PASSWORD: z.string().default("nats"),
});

export type Config = z.infer<typeof ConfigSchema>;

const parsed = ConfigSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    "❌ Invalid environment variables:",
    JSON.stringify(parsed.error, null, 2)
  );
  process.exit(1);
}
export const config = parsed.data;
