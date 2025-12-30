import { ChatOllama } from "@langchain/ollama";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

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
export function getLLM(temperatureOverride?: number): BaseChatModel {
  const temperature = temperatureOverride ?? currentConfig.temperature;

  switch (currentConfig.provider) {
    case "ollama":
      return new ChatOllama({
        model: currentConfig.model,
        temperature,
      });

    default:
      return new ChatOllama({
        model: currentConfig.model,
        temperature,
      });
  }
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
