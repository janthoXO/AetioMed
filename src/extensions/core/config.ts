import z from "zod";

const PossibleProvidersSchema = z.enum(["ollama", "google"]);
type PossibleProviders = z.infer<typeof PossibleProvidersSchema>;

const providersPattern = PossibleProvidersSchema.options.join("|");
const allowedLlmsRegex = new RegExp(
  `^(${providersPattern}):([^,\\s]+)(,(${providersPattern}):([^,\\s]+))*$`
);

export const ConfigSchema = z
  .object({
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
    const {
      ALLOWED_LLMS,
      LLM_PROVIDER,
      LLM_MODEL,
      LLM_API_KEY,
      LLM_URL,
      LLM_TEMPERATURE,
      ...rest
    } = env;
    if (process.env.FEATURES?.includes("ALLOW_LLMS")) {
      return { ...rest, allowedLlms: ALLOWED_LLMS, llm: undefined };
    }

    if (!(LLM_PROVIDER && LLM_MODEL)) {
      throw new Error(
        "LLM_PROVIDER and LLM_MODEL are required when ALLOW_LLMS is not enabled"
      );
    }

    return {
      ...rest,
      llm: {
        provider: LLM_PROVIDER,
        model: LLM_MODEL,
        apiKey: LLM_API_KEY,
        url: LLM_URL,
        temperature: LLM_TEMPERATURE,
      },
      allowedLlms: undefined,
    };
  });

export type Config = z.infer<typeof ConfigSchema>;
