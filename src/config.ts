import dotenv from "dotenv";
import z from "zod";

dotenv.config();

const PossibleProvidersSchema = z.enum(["ollama", "google"]);
type PossibleProviders = z.infer<typeof PossibleProvidersSchema>;

const providersPattern = PossibleProvidersSchema.options.join("|");
const allowedLlmsRegex = new RegExp(
  `^(${providersPattern}):([^,\\s]+)(,(${providersPattern}):([^,\\s]+))*$`
);

const EnvSchema = z
  .object({
    DEBUG: z.coerce.boolean().default(false),
    PORT: z.coerce.number().default(3030),

    FEATURES: z
      .string()
      .default("")
      .transform(
        (val) =>
          new Set(
            val
              .split(",")
          )
      ),

    LLM_PROVIDER: PossibleProvidersSchema.optional(),
    LLM_MODEL: z.string().optional(),
    LLM_API_KEY: z.string().optional(),
    LLM_URL: z.url().optional(),
    LLM_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.7),

    ALLOWED_LLMS: z
      .string()
      .regex(allowedLlmsRegex)
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

            if (!acc[provider as PossibleProviders]) {
              acc[provider as PossibleProviders] = [];
            }

            acc[provider as PossibleProviders].push(model);
            return acc;
          },
          {} as Record<PossibleProviders, string[]>
        );
      }),
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
            provider: LLM_PROVIDER as PossibleProviders,
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
    const { DEBUG, PORT, FEATURES, ALLOWED_LLMS, ...rest } = env;

    return {
      debug: DEBUG,
      port: PORT,
      features: FEATURES,
      allowedLlms: ALLOWED_LLMS,
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
