import { ChatOllama, type ChatOllamaInput } from "@langchain/ollama";
import { ChatGoogle, type ChatGoogleParams } from "@langchain/google";
import { ChatOpenAI, type ChatOpenAIFields } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  JsonOutputParser,
  StructuredOutputParser,
} from "@langchain/core/output_parsers";
import { ModelUnreachableError } from "@/core/graph/errors/AppError.js";
import { tool } from "@langchain/core/tools";
import z from "zod";
import { Ollama } from "ollama";
import type { Message } from "@langchain/core/messages";
import { jsonrepair } from "jsonrepair";
import {
  LLMConfigSchema,
  type LLMConfig,
} from "@/core/graph/models/LLMConfig.js";
import type { Config } from "@/core/graph/config.js";
import type { LlmPort } from "@/core/graph/runtime.js";

/**
 * The concrete `LlmPort` used outside tests: constructs a real LangChain
 * chat model via `getLLM`, closing over the process's global default config
 * (from env) so callers never read a module-scope singleton.
 */
export function createLlmPort(defaultConfig: Config): LlmPort {
  return {
    chat(llmConfig) {
      return getLLM(defaultConfig, llmConfig);
    },
  };
}

/**
 * Get an LLM instance for the given global default config, overridden by
 * `llmConfig`. Callers no longer read a module-scope config singleton — the
 * default comes from whatever `LlmPort` (see `runtime.ts`) they were built
 * against, which is what makes this injectable/fakeable in tests.
 */
export function getLLM(
  defaultConfig: Config,
  llmConfig: Partial<LLMConfig> = {}
): BaseChatModel {
  const fullConfig = LLMConfigSchema.parse({
    ...defaultConfig.llm,
    ...llmConfig,
  });

  console.debug("LLM Configuration:", fullConfig);

  let chat: BaseChatModel;
  switch (fullConfig.provider) {
    case "ollama": {
      const ollamaConfig: ChatOllamaInput = {
        model: fullConfig.model,
        temperature: fullConfig.temperature,
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
        temperature: fullConfig.temperature,
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
        temperature: fullConfig.temperature,
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

export function getSearchTool(llmConfig: LLMConfig) {
  switch (llmConfig.provider) {
    case "ollama": {
      return tool(
        async ({ query }: { query: string }) => {
          return await new Ollama({
            headers: {
              Authorization: "Bearer " + llmConfig.apiKey,
            },
          }).webSearch({ query: query });
        },
        {
          name: "web_search",
          description: "Searches the web for information related to a query.",
          schema: z.object({
            query: z.string().describe("The query to search for on the web"),
          }),
        }
      );
    }
    case "google": {
      return {
        googleSearch: {},
      };
    }
    default:
      throw new Error(`Unsupported LLM Provider: ${llmConfig.provider}`);
  }
}

/**
 * Get a low-temperature LLM for deterministic tasks: judges/evaluations,
 * yes-no decisions, translations, and factual enumeration where accuracy
 * matters and variety is unwanted.
 */
export function getDeterministicLLM(
  llm: LlmPort,
  llmConfig: Partial<Omit<LLMConfig, "temperature">> = {}
): BaseChatModel {
  return llm.chat({ ...llmConfig, temperature: 0.1 });
}

/**
 * Get a mid-temperature LLM for grounded structured generation: clinical
 * decision-making and outputs whose content is already pinned down by an
 * outline/blueprint, where fidelity beats variety but a little flexibility
 * in wording is still useful.
 */
export function getBalancedLLM(
  llm: LlmPort,
  llmConfig: Partial<Omit<LLMConfig, "temperature">> = {}
): BaseChatModel {
  return llm.chat({ ...llmConfig, temperature: 0.4 });
}

/**
 * Get a creative LLM for open-ended narrative generation (case outlines,
 * patient voice, demographics) where run-to-run variety is a feature.
 */
export function getCreativeLLM(
  llm: LlmPort,
  llmConfig: Partial<Omit<LLMConfig, "temperature">> = {}
): BaseChatModel {
  return llm.chat({ ...llmConfig, temperature: 0.7 });
}

/**
 * Decodes a string into an object based on the configured LLM format.
 * @param input
 * @returns
 */
export async function decodeObject(
  input: string,
  schema?: z.ZodObject
): Promise<object> {
  const parser = schema
    ? new StructuredOutputParser(schema)
    : new JsonOutputParser();
  return parser.parse(input);
}

export function parseStructuredResponse<T>(
  response: string,
  schema: z.ZodSchema<T>
): T {
  try {
    return schema.parse(JSON.parse(response));
  } catch {
    const repaired = jsonrepair(response);
    console.debug("Repaired JSON:", repaired);
    return schema.parse(JSON.parse(repaired));
  }
}

export function parseStructuredResponseAgent<T>(
  result: { messages: Message[]; structuredResponse?: T },
  schema: z.ZodSchema<T>
): T {
  if (result.structuredResponse) {
    return result.structuredResponse;
  }

  const content = result.messages[result.messages.length - 1]?.content;
  if (typeof content !== "string") {
    throw new Error("LLM response content is not a string");
  }

  return parseStructuredResponse(content, schema);
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
