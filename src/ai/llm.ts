import { ChatOllama, type ChatOllamaInput } from "@langchain/ollama";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { config } from "@/utils/config.js";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { ModelUnreachableError } from "@/errors/AppError.js";

/**
 * Get an LLM instance based on current configuration.
 * Easily extendable to support cloud providers.
 */
export function getLLM(temperatureOverride?: number): BaseChatModel {
  const temperature = temperatureOverride ?? config.LLM_TEMPERATURE;

  let chat: BaseChatModel;
  switch (config.LLM_PROVIDER) {
    case "ollama": {
      const ollamaConfig: ChatOllamaInput = {
        model: config.LLM_MODEL,
        temperature,
        format: "json",
      };

      chat = new ChatOllama(ollamaConfig);
      break;
    }
    default:
      throw new Error(`Unsupported LLM Provider: ${config.LLM_PROVIDER}`);
  }

  return chat;
}

/**
 * Get a low-temperature LLM for deterministic tasks (consistency checks, etc.)
 */
export function getDeterministicLLM(): BaseChatModel {
  return getLLM(0.1);
}

/**
 * Get a creative LLM for generation tasks
 */
export function getCreativeLLM(): BaseChatModel {
  return getLLM(0.8);
}

/**
 * Decodes a string into an object based on the configured LLM format.
 * @param input
 * @returns
 */
export async function decodeObject(input: string): Promise<object> {
  const parser = new JsonOutputParser();
  return parser.parse(input);
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
