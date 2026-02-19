import dotenv from "dotenv";
import z from "zod";

dotenv.config();

export const LLMProviderSchema = z.enum(["ollama", "google"]);

export type LLMProvider = z.infer<typeof LLMProviderSchema>;

const ConfigSchema = z.object({
  PORT: z.coerce.number().default(3030),
  DEBUG: z.coerce.boolean().default(false),
  LLM_API_KEY: z.string().optional(),
  LLM_PROVIDER: LLMProviderSchema.default("ollama"),
  LLM_MODEL: z
    .string()
    .default("hf.co/mradermacher/JSL-MedQwen-14b-reasoning-i1-GGUF:Q4_K_S"),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.7),

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
