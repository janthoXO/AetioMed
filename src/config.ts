import dotenv from "dotenv";
import z from "zod";
import {
  LLMProviderSchema,
  type LLMProvider,
} from "./core/models/LLMConfig.js";

dotenv.config();

export const FeatureFlagSchema = z.enum([
  "ALLOW_LLMS",
  "NATS",
  "TRACING",
  "PERSISTENCY",
]);

const EnvSchema = z
  .object({
    DEBUG: z.coerce.boolean().default(false),
    PORT: z.coerce.number().default(3030),

    FEATURES: z
      .string()
      .default("")
      .transform((val) => new Set(String(val).split(","))),

    LLM_PROVIDER: LLMProviderSchema.optional(),
    LLM_MODEL: z.string().optional(),
    LLM_API_KEY: z.string().optional(),
    LLM_URL: z.url().optional(),
    LLM_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.7),

    ALLOWED_LLMS: z
      .string()
      .regex(/^([^:\s]+):([^,\s]+)(,([^:\s]+):([^,\s]+))*$/)
      .optional()
      .transform((val) => {
        if (!val) return undefined;

        const pairs = String(val).split(",");
        return pairs.reduce(
          (acc, pair) => {
            const [provider, model] = pair.split(":", 2);
            if (!provider || !model) {
              throw new Error(
                `Invalid ALLOWED_LLMS format for pair "${pair}". Expected format is "PROVIDER:MODEL".`
              );
            }

            if (!acc[provider as LLMProvider]) {
              acc[provider as LLMProvider] = [];
            }

            acc[provider as LLMProvider].push(model);
            return acc;
          },
          {} as Record<LLMProvider, string[]>
        );
      }),

    // NATS
    NATS_URL: z.url().optional(),
    NATS_USER: z.string().default("nats"),
    NATS_PASSWORD: z.string().default("nats"),

    // Redis
    REDIS_URL: z.url().optional(),
  })
  .transform((env) => {
    if (env.FEATURES.has("ALLOW_LLMS") && !env.ALLOWED_LLMS) {
      throw new Error(
        "ALLOWED_LLMS must be specified when ALLOW_LLMS feature is enabled"
      );
    }

    if (
      !env.FEATURES.has("ALLOW_LLMS") &&
      (!env.LLM_PROVIDER || !env.LLM_MODEL)
    ) {
      throw new Error(
        "LLM_PROVIDER and LLM_MODEL must be specified when ALLOW_LLMS feature is disabled"
      );
    }

    const {
      LLM_PROVIDER,
      LLM_MODEL,
      LLM_API_KEY,
      LLM_URL,
      LLM_TEMPERATURE,
      ...rest
    } = env;

    return {
      ...rest,
      llm: !env.FEATURES.has("ALLOW_LLMS")
        ? {
            provider: LLM_PROVIDER as LLMProvider,
            model: LLM_MODEL as string,
            apiKey: LLM_API_KEY,
            url: LLM_URL,
            temperature: LLM_TEMPERATURE,
            outputFormat: "json" as const,
          }
        : undefined,
    };
  })
  .transform((env) => {
    if (env.FEATURES.has("NATS") && !env.NATS_URL) {
      throw new Error(
        "NATS_URL must be specified when NATS feature is enabled"
      );
    }

    const { NATS_URL, NATS_USER, NATS_PASSWORD, ...rest } = env;

    return {
      ...rest,
      nats: env.FEATURES.has("NATS")
        ? {
            url: NATS_URL as string,
            user: NATS_USER,
            password: NATS_PASSWORD,
          }
        : undefined,
    };
  })
  .transform((env) => {
    if (env.FEATURES.has("PERSISTENCY") && !env.REDIS_URL) {
      throw new Error(
        "REDIS_URL must be specified when PERSISTENCY feature is enabled"
      );
    }

    const { REDIS_URL, ...rest } = env;

    return {
      ...rest,
      redis: env.FEATURES.has("PERSISTENCY")
        ? {
            url: REDIS_URL as string,
          }
        : undefined,
    };
  })
  .transform((env) => {
    const { DEBUG, PORT, FEATURES, ...rest } = env;

    return {
      debug: DEBUG,
      port: PORT,
      features: FEATURES,
      ...rest,
    };
  });

export type Config = z.output<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(
    `❌ Invalid environment variables: ${JSON.stringify(parsed.error, null, 2)}`
  );
}

export const config = parsed.data;
