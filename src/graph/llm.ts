import { ChatOllama } from "@langchain/ollama";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { InteropZodType } from "@langchain/core/utils/types";

export interface LLMConfig {
  provider: "ollama";
  model: string;
  temperature: number;
}

const defaultConfig: LLMConfig = {
  provider: "ollama",
  model: "hf.co/mradermacher/JSL-MedQwen-14b-reasoning-i1-GGUF:Q4_K_S",
  temperature: 0.7,
};

let currentConfig: LLMConfig = { ...defaultConfig };

/**
 * Configure the LLM provider globally
 */
export function configureLLM(config: Partial<LLMConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

/**
 * Get an LLM instance based on current configuration.
 * Easily extendable to support cloud providers.
 */
export function getLLM(
  temperatureOverride?: number,
  structuredOutput?: InteropZodType
): BaseChatModel {
  const temperature = temperatureOverride ?? currentConfig.temperature;

  let chat: BaseChatModel;
  switch (currentConfig.provider) {
    case "ollama":
      chat = new ChatOllama({
        model: currentConfig.model,
        temperature,
      });
      break;
    default:
      chat = new ChatOllama({
        model: currentConfig.model,
        temperature,
      });
      break;
  }

  if (structuredOutput) {
    chat.withStructuredOutput(structuredOutput);
  }

  return chat;
}

/**
 * Get a low-temperature LLM for deterministic tasks (consistency checks, etc.)
 */
export function getDeterministicLLM(
  structuredOutput?: InteropZodType
): BaseChatModel {
  return getLLM(0.1, structuredOutput);
}

/**
 * Get a creative LLM for generation tasks
 */
export function getCreativeLLM(
  structuredOutput?: InteropZodType
): BaseChatModel {
  return getLLM(0.8, structuredOutput);
}
