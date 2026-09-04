import z from "zod";
import { LLM_ROLES, type LlmRole } from "./runtime.js";

const PossibleProvidersSchema = z.enum(["ollama", "google", "openai"]);
type PossibleProviders = z.infer<typeof PossibleProvidersSchema>;

const providersPattern = PossibleProvidersSchema.options.join("|");
const allowedLlmsRegex = new RegExp(
  `^(${providersPattern}):([^,\\s]+)(,(${providersPattern}):([^,\\s]+))*$`
);

/** Resolved provider/model/apiKey/url for one role or the general fallback. */
interface LlmRoleConfig {
  provider: PossibleProviders;
  model: string;
  apiKey?: string | undefined;
  url?: string | undefined;
}

/**
 * Per-field fallback (not per-role): a role that sets only `MODEL` still
 * inherits the general provider/apiKey/url. A role that sets `PROVIDER`
 * without `MODEL` is rejected — otherwise per-field fallback would resolve
 * to a model name from the wrong provider's namespace.
 */
function resolveRole(
  role: LlmRole,
  fields: {
    provider?: PossibleProviders | undefined;
    model?: string | undefined;
    apiKey?: string | undefined;
    url?: string | undefined;
  },
  general: LlmRoleConfig
): LlmRoleConfig {
  const prefix = `LLM_${role.toUpperCase()}`;

  if (fields.provider && !fields.model) {
    throw new Error(
      `${prefix}_PROVIDER is set without ${prefix}_MODEL. A role that overrides the provider ` +
        `must also set the model — otherwise it would resolve to a model name from the wrong ` +
        `provider's namespace.`
    );
  }

  if (
    fields.provider &&
    fields.provider !== general.provider &&
    !fields.apiKey
  ) {
    console.warn(
      `[config] ${prefix}_PROVIDER (${fields.provider}) differs from the general provider ` +
        `(${general.provider}) but ${prefix}_API_KEY is not set — inheriting the general API ` +
        `key, which is almost certainly for the wrong service unless both are keyless local ` +
        `endpoints.`
    );
  }

  return {
    provider: fields.provider ?? general.provider,
    model: fields.model ?? general.model,
    apiKey: fields.apiKey ?? general.apiKey,
    url: fields.url ?? general.url,
  };
}

export const ConfigSchema = z
  .object({
    // Declared here (rather than read from the process environment directly
    // inside the transform below) so this module performs no I/O of its
    // own — the caller already passes the full environment to `.parse()`,
    // so this is a pure re-slice of that same input, not a new read.
    FEATURES: z.string().optional(),
    LLM_PROVIDER: PossibleProvidersSchema.optional(),
    LLM_MODEL: z.string().optional(),
    LLM_API_KEY: z.string().optional(),
    LLM_URL: z.url().optional(),

    LLM_GENERATOR_PROVIDER: PossibleProvidersSchema.optional(),
    LLM_GENERATOR_MODEL: z.string().optional(),
    LLM_GENERATOR_API_KEY: z.string().optional(),
    LLM_GENERATOR_URL: z.url().optional(),

    LLM_JUDGE_PROVIDER: PossibleProvidersSchema.optional(),
    LLM_JUDGE_MODEL: z.string().optional(),
    LLM_JUDGE_API_KEY: z.string().optional(),
    LLM_JUDGE_URL: z.url().optional(),

    LLM_TRANSLATOR_PROVIDER: PossibleProvidersSchema.optional(),
    LLM_TRANSLATOR_MODEL: z.string().optional(),
    LLM_TRANSLATOR_API_KEY: z.string().optional(),
    LLM_TRANSLATOR_URL: z.url().optional(),
    /**
     * When set, small-model-friendly prompting adjustments are enabled
     */
    LLM_SMALL: z
      .string()
      .optional()
      .transform((v) => v === "true" || v === "1"),
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
      FEATURES,
      ALLOWED_LLMS,
      LLM_PROVIDER,
      LLM_MODEL,
      LLM_API_KEY,
      LLM_URL,
      LLM_GENERATOR_PROVIDER,
      LLM_GENERATOR_MODEL,
      LLM_GENERATOR_API_KEY,
      LLM_GENERATOR_URL,
      LLM_JUDGE_PROVIDER,
      LLM_JUDGE_MODEL,
      LLM_JUDGE_API_KEY,
      LLM_JUDGE_URL,
      LLM_TRANSLATOR_PROVIDER,
      LLM_TRANSLATOR_MODEL,
      LLM_TRANSLATOR_API_KEY,
      LLM_TRANSLATOR_URL,
      ...rest
    } = env;
    if (FEATURES?.includes("ALLOW_LLMS")) {
      return {
        ...rest,
        allowedLlms: ALLOWED_LLMS,
        llm: undefined,
        llmRoles: undefined,
      };
    }

    if (!(LLM_PROVIDER && LLM_MODEL)) {
      throw new Error(
        "LLM_PROVIDER and LLM_MODEL are required when ALLOW_LLMS is not enabled"
      );
    }

    const llm: LlmRoleConfig = {
      provider: LLM_PROVIDER,
      model: LLM_MODEL,
      apiKey: LLM_API_KEY,
      url: LLM_URL,
    };

    const roleFields: Record<
      LlmRole,
      {
        provider?: PossibleProviders | undefined;
        model?: string | undefined;
        apiKey?: string | undefined;
        url?: string | undefined;
      }
    > = {
      generator: {
        provider: LLM_GENERATOR_PROVIDER,
        model: LLM_GENERATOR_MODEL,
        apiKey: LLM_GENERATOR_API_KEY,
        url: LLM_GENERATOR_URL,
      },
      judge: {
        provider: LLM_JUDGE_PROVIDER,
        model: LLM_JUDGE_MODEL,
        apiKey: LLM_JUDGE_API_KEY,
        url: LLM_JUDGE_URL,
      },
      translator: {
        provider: LLM_TRANSLATOR_PROVIDER,
        model: LLM_TRANSLATOR_MODEL,
        apiKey: LLM_TRANSLATOR_API_KEY,
        url: LLM_TRANSLATOR_URL,
      },
    };

    const llmRoles = Object.fromEntries(
      LLM_ROLES.map((role) => [role, resolveRole(role, roleFields[role], llm)])
    ) as Record<LlmRole, LlmRoleConfig>;

    return {
      ...rest,
      llm,
      llmRoles,
      allowedLlms: undefined,
    };
  });

export type Config = z.infer<typeof ConfigSchema>;
