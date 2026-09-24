import { ChatOllama, type ChatOllamaInput } from "@langchain/ollama";
import { ChatGoogle, type ChatGoogleParams } from "@langchain/google";
import { ChatOpenAI, type ChatOpenAIFields } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ModelUnreachableError } from "@/core/graph/errors/AppError.js";
import {
  LLMConfigSchema,
  type LLMConfig,
} from "@/core/graph/models/LLMConfig.js";
import type { Config } from "@/core/graph/config.js";
import type { LlmPort, LlmTemperature } from "@/core/graph/runtime.js";

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
export function createLlmPort(defaultConfig: Config): LlmPort {
  return {
    for(opts, llmConfig) {
      const roleConfig = defaultConfig.llmRoles?.[opts.role];
      return getLLM(
        roleConfig,
        llmConfig,
        TEMPERATURE_BY_CLASS[opts.temperature]
      );
    },
  };
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

  console.debug("LLM Configuration:", fullConfig, { temperature });

  let chat: BaseChatModel;
  switch (fullConfig.provider) {
    case "ollama": {
      const ollamaConfig: ChatOllamaInput = {
        model: fullConfig.model,
        temperature,
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

      chat = new ChatOllama(ollamaConfig);
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
      chat = new ChatGoogle(googleConfig);
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

      chat = new ChatOpenAI(openAIConfig);
      break;
    }
    default:
      throw new Error(`Unsupported LLM Provider: ${fullConfig.provider}`);
  }

  return chat;
}

export function handleLangchainError(error: Error): never {
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
