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

/**
 * Fixed policy classes, not configuration — see `docs/issues/06-llm-roles.md`
 * §1: `LLM_TEMPERATURE` was dead config (every call site went through one of
 * these three fixed values, which always won the merge), so it was deleted
 * rather than made per-role. These values are what each class has always
 * used; this issue only changes *who* is called (role), never *how hot*.
 */
const TEMPERATURE_BY_CLASS: Record<LlmTemperature, number> = {
  /** Judges/evaluations, yes-no decisions, translations, and factual
   * enumeration where accuracy matters and variety is unwanted. */
  deterministic: 0.1,
  /** Grounded structured generation: clinical decision-making and outputs
   * whose content is already pinned down by an outline/blueprint, where
   * fidelity beats variety but a little flexibility in wording is useful. */
  balanced: 0.4,
  /** Open-ended narrative generation (case outlines, patient voice,
   * demographics) where run-to-run variety is a feature. */
  creative: 0.7,
};

/**
 * The concrete `LlmPort` used outside tests: constructs a real LangChain
 * chat model via `getLLM`, closing over the process's per-role default
 * configs (from env) so callers never read a module-scope singleton.
 */
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
 * Get an LLM instance for the given role's default config (undefined under
 * `ALLOW_LLMS`, where every field must come from `llmConfig`), overridden by
 * `llmConfig`. Callers no longer read a module-scope config singleton — the
 * default comes from whatever `LlmPort` (see `runtime.ts`) they were built
 * against, which is what makes this injectable/fakeable in tests.
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

      // vLLM-style OpenAI-compatible servers toggle the thinking phase via
      // the chat template (verified against Morpheus; not an official OpenAI
      // parameter, which ignores unknown body fields).
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
