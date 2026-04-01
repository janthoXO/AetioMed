import dotenv from "dotenv";
import z from "zod";
import { LLMProviderSchema, type LLMConfig } from "./models/LLMConfig.js";

dotenv.config();

const EnvSchema = z
  .object({
    DEBUG: z.coerce.boolean().default(false),
    PORT: z.coerce.number().default(3030),

    LLM_PROVIDER: LLMProviderSchema.optional(),
    LLM_MODEL: z.string().optional(),
    LLM_API_KEY: z.string().optional(),
    LLM_URL: z.url().optional(),
    LLM_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.7),

    // NATS
    NATS_URL: z.url().optional(),
    NATS_USER: z.string().default("nats"),
    NATS_PASSWORD: z.string().default("nats"),

    // Redis
    REDIS_URL: z.url().optional(),
  })
  .transform((env) => {
    let transformedEnv: Config = {
      port: env.PORT,
      debug: env.DEBUG,
    };

    if (env.LLM_PROVIDER && env.LLM_MODEL) {
      transformedEnv = {
        ...transformedEnv,
        llm: {
          provider: env.LLM_PROVIDER,
          model: env.LLM_MODEL,
          apiKey: env.LLM_API_KEY,
          url: env.LLM_URL,
          temperature: env.LLM_TEMPERATURE,
          outputFormat: "json",
        },
      };
    }

    if (env.NATS_URL) {
      transformedEnv = {
        ...transformedEnv,
        nats: {
          url: env.NATS_URL,
          user: env.NATS_USER,
          password: env.NATS_PASSWORD,
        },
      };
    }

    if (env.REDIS_URL) {
      transformedEnv = {
        ...transformedEnv,
        redis: {
          url: env.REDIS_URL,
        },
      };
    }

    return transformedEnv;
  });

export type Config = {
  debug: boolean;
  port: number;

  llm?: LLMConfig;

  nats?: {
    url: string;
    user: string;
    password: string;
  };

  redis?: {
    url: string;
  };
};

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error(
    "❌ Invalid environment variables:",
    JSON.stringify(parsed.error, null, 2)
  );
  process.exit(1);
}

export const config = parsed.data;
