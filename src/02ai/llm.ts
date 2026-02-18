import { ChatOllama, type ChatOllamaInput } from "@langchain/ollama";
import { ChatGoogle, type ChatGoogleParams } from "@langchain/google";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { config as envConfig } from "@/config.js";
import {
  JsonOutputParser,
  StructuredOutputParser,
} from "@langchain/core/output_parsers";
import { ModelUnreachableError } from "@/errors/AppError.js";
import { tool } from "langchain";
import z from "zod";
import { Ollama } from "ollama";
import type { Message } from "@langchain/core/messages";
import { jsonrepair } from "jsonrepair";

type LLMConfig = {
  temperature: number;
  outputFormat?: "json" | "text";
};

/**
 * Get an LLM instance based on current configuration.
 * Easily extendable to support cloud providers.
 */
export function getLLM(llmConfig?: LLMConfig): BaseChatModel {
  const temperature = llmConfig?.temperature ?? envConfig.LLM_TEMPERATURE;

  let chat: BaseChatModel;
  switch (envConfig.LLM_PROVIDER) {
    case "ollama": {
      const ollamaConfig: ChatOllamaInput = {
        model: envConfig.LLM_MODEL,
        temperature,
      };

      if (!llmConfig || llmConfig?.outputFormat === "json") {
        ollamaConfig.format = "json";
      }

      if (envConfig.LLM_API_KEY) {
        ollamaConfig.headers = {
          Authorization: "Bearer " + envConfig.LLM_API_KEY,
        };
      }

      chat = new ChatOllama(ollamaConfig);
      break;
    }
    case "google": {
      const googleConfig: ChatGoogleParams = {
        apiKey: envConfig.LLM_API_KEY ?? "",
        model: envConfig.LLM_MODEL,
        temperature,
      };
      chat = new ChatGoogle(googleConfig);
      break;
    }
    default:
      throw new Error(`Unsupported LLM Provider: ${envConfig.LLM_PROVIDER}`);
  }

  return chat;
}

export function getSearchTool() {
  switch (envConfig.LLM_PROVIDER) {
    case "ollama": {
      return tool(
        async ({ query }: { query: string }) => {
          return await new Ollama({
            headers: {
              Authorization: "Bearer " + envConfig.LLM_API_KEY,
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
      throw new Error(`Unsupported LLM Provider: ${envConfig.LLM_PROVIDER}`);
  }
}

/**
 * Get a low-temperature LLM for deterministic tasks (consistency checks, etc.)
 */
export function getDeterministicLLM(
  config?: Omit<LLMConfig, "temperature">
): BaseChatModel {
  return getLLM({ temperature: 0.1, ...config });
}

/**
 * Get a creative LLM for generation tasks
 */
export function getCreativeLLM(
  config?: Omit<LLMConfig, "temperature">
): BaseChatModel {
  return getLLM({ temperature: 0.8, ...config });
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
