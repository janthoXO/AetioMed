import { ChatOllama, type ChatOllamaInput } from "@langchain/ollama";
import { ChatGoogle, type ChatGoogleParams } from "@langchain/google";
import { ChatOpenAI, type ChatOpenAIFields } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { ModelUnreachableError } from "@/core/graph/errors/AppError.js";
import {
  LLMConfigSchema,
  type LLMConfig,
} from "@/core/graph/shared/domain/LLMConfig.js";
import type { z } from "zod";
import type { RequestContext } from "@/core/graph/utils/context.js";
import type { Config } from "@/core/graph/config.js";
import type { LlmPort, LlmRole, LlmTemperature } from "@/core/graph/runtime.js";
import { portableSchema } from "./portableSchema.js";

/** Fixed policy classes, not configuration. */
const TEMPERATURE_BY_CLASS: Record<LlmTemperature, number> = {
  /** Judges, yes-no decisions, translations, factual enumeration. */
  deterministic: 0.1,
  /** Grounded structured generation pinned by an outline; fidelity over variety. */
  balanced: 0.4,
  /** Open-ended narrative (outlines, patient voice, demographics). */
  creative: 0.7,
};

/** Real `LlmPort`: builds LangChain chat models via `getLLM` from per-role default configs. */
export function createLlmPort(config: Config): LlmPort {
  return chatModelLlmPort((call, llmConfig) =>
    getLLM(
      config.llmRoles?.[call.role],
      llmConfig,
      TEMPERATURE_BY_CLASS[call.temperature]
    )
  );
}

const OLLAMA_NUM_CTX = 16384;

/** `LlmPort` over any LangChain chat-model factory. Real port uses `getLLM`; tests pass a fake model. */
export function chatModelLlmPort(
  modelFor: (
    call: { role: LlmRole; temperature: LlmTemperature },
    llmConfig: Partial<LLMConfig> | undefined
  ) => BaseChatModel
): LlmPort {
  return {
    async structured<T>(
      call: { role: LlmRole; temperature: LlmTemperature },
      prompt: { system: string; user: string },
      schema: z.ZodType<T>,
      context?: RequestContext
    ): Promise<T> {
      // Lossless, provider-independent grammar; per-provider native mode is
      // `getLLM`'s `structuredVia`.
      const portable = portableSchema(
        toJsonSchema(schema) as Record<string, unknown>
      );
      const result = await modelFor(call, context?.llmConfig)
        .withStructuredOutput(portable.schema)
        .invoke(
          [new SystemMessage(prompt.system), new HumanMessage(prompt.user)],
          context?.signal !== undefined ? { signal: context.signal } : undefined
        )
        .catch((error: Error) => handleLangchainError(error));
      // Not every provider's parser validates against the schema; gateways'
      // retries rely on a validation error here.
      return schema.parse(portable.unwrap(result));
    },
    async text(call, prompt, context) {
      const result = await modelFor(call, {
        ...context?.llmConfig,
        outputFormat: "text",
      })
        .invoke(
          [new SystemMessage(prompt.system), new HumanMessage(prompt.user)],
          context?.signal !== undefined ? { signal: context.signal } : undefined
        )
        .catch((error: Error) => handleLangchainError(error));
      return result.text;
    },
  };
}

function handleLangchainError(error: Error): never {
  if (error instanceof Error) {
    if (
      error.message.includes("fetch failed") ||
      error.message.includes("ECONNREFUSED")
    ) {
      throw new ModelUnreachableError(
        "Ollama service is unreachable. Is it running?",
        error.message
      );
    }
  }

  throw error;
}

/**
 * LLM for role default config (undefined under `ALLOW_LLMS`: all fields then
 * come from `llmConfig`), overridden by `llmConfig`.
 */
function getLLM(
  roleConfig: Partial<LLMConfig> | undefined,
  llmConfig: Partial<LLMConfig> | undefined,
  temperature: number
): BaseChatModel {
  const fullConfig = LLMConfigSchema.parse({
    ...roleConfig,
    ...llmConfig,
  });

  const { apiKey, ...loggable } = fullConfig;
  console.debug(
    "LLM Configuration:",
    { ...loggable, apiKey: apiKey && "<redacted>" },
    { temperature }
  );

  let chat: BaseChatModel;
  switch (fullConfig.provider) {
    case "ollama": {
      const ollamaConfig: ChatOllamaInput = {
        model: fullConfig.model,
        temperature,
        // Ollama default 4096 ctx keeps ~2k prompt tokens and silently drops
        // the oldest (system prompt first); procedure prompts reach ~2.5k.
        // ponytail: fixed size, make configurable if a 16k KV cache won't fit.
        numCtx: OLLAMA_NUM_CTX,
      };

      if (!fullConfig || fullConfig?.outputFormat === "json") {
        ollamaConfig.format = "json";
      }

      if (fullConfig.url) {
        ollamaConfig.baseUrl = fullConfig.url;
      }

      if (fullConfig.apiKey) {
        ollamaConfig.headers = {
          Authorization: "Bearer " + fullConfig.apiKey,
        };
      }

      if (fullConfig.enableThinking !== undefined) {
        ollamaConfig.think = fullConfig.enableThinking;
      }

      // Per-call `format: <schema>` overrides `format: "json"` (llm.test.ts).
      chat = structuredVia(new ChatOllama(ollamaConfig), {
        method: "jsonSchema",
      });
      break;
    }
    case "google": {
      if (!fullConfig.apiKey) {
        throw new ModelUnreachableError("Google API key is not configured");
      }

      const googleConfig: ChatGoogleParams = {
        apiKey: fullConfig.apiKey,
        model: fullConfig.model,
        temperature,
      };
      // Native `responseJsonSchema`; LangChain's default is tool calling.
      chat = structuredVia(new ChatGoogle(googleConfig), {
        method: "jsonSchema",
      });
      break;
    }
    case "openai": {
      if (!fullConfig.apiKey) {
        throw new ModelUnreachableError("OpenAI API key is not configured");
      }

      const openAIConfig: ChatOpenAIFields = {
        apiKey: fullConfig.apiKey,
        model: fullConfig.model,
        temperature,
        // Stream so a slow server keeps sending tokens: proxies in front of
        // vLLM (e.g. Open WebUI) cut a silent request after ~300s.
        streaming: true,
      };

      if (fullConfig.url) {
        openAIConfig.configuration = {
          baseURL: fullConfig.url,
        };
      }

      // vLLM-style servers toggle thinking via chat template; not an official
      // OpenAI param (ignored there).
      if (fullConfig.enableThinking !== undefined) {
        openAIConfig.modelKwargs = {
          chat_template_kwargs: {
            enable_thinking: fullConfig.enableThinking,
          },
        };
      }

      chat = structuredVia(new ChatOpenAI(openAIConfig), {
        method: "jsonSchema",
        strict: true,
      });
      break;
    }
    default:
      throw new Error(`Unsupported LLM Provider: ${fullConfig.provider}`);
  }

  return chat;
}

/**
 * Pins how `model.withStructuredOutput` asks this provider for structured
 * output (`config`: native mode, strict where it exists) — overridden on the
 * instance so `getLLM` still returns a plain `BaseChatModel`. The schema it
 * receives is already {@link portableSchema}'s lossless rewrite (the port does
 * that); a provider that rejects some keyword (Anthropic: bounds) adds its
 * lossy rewrite here.
 */
function structuredVia(
  model: BaseChatModel,
  config: { method: "jsonSchema"; strict?: boolean }
): BaseChatModel {
  const native = model.withStructuredOutput.bind(model);
  model.withStructuredOutput = ((
    schema: Parameters<typeof native>[0],
    callConfig?: Parameters<typeof native>[1]
  ) => native(schema, { ...callConfig, ...config })) as typeof native;
  return model;
}
