import { ChatOllama, type ChatOllamaInput } from "@langchain/ollama";
import { ChatGoogle, type ChatGoogleParams } from "@langchain/google";
import { ChatOpenAI, type ChatOpenAIFields } from "@langchain/openai";
import {
  SystemMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ModelUnreachableError } from "@/core/graph/errors/AppError.js";
import {
  LLMConfigSchema,
  type LLMConfig,
} from "@/core/graph/shared/domain/LLMConfig.js";
import type { z } from "zod";
import type { RequestContext } from "@/core/graph/utils/context.js";
import type { Config } from "@/core/graph/config.js";
import type { LlmPort, LlmRole, LlmTemperature } from "@/core/graph/runtime.js";

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
      return (await modelFor(call, context?.llmConfig)
        .withStructuredOutput(schema)
        .invoke(
          [new SystemMessage(prompt.system), new HumanMessage(prompt.user)],
          context?.signal !== undefined ? { signal: context.signal } : undefined
        )
        .catch((error: Error) => handleLangchainError(error))) as T;
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
    async agent(call, prompt, tools, opts, context) {
      // "text": Ollama's format=json breaks tool calls.
      const model = modelFor(call, {
        ...context?.llmConfig,
        outputFormat: "text",
      });
      if (!model.bindTools) {
        throw new Error("Configured chat model does not support tool calling");
      }
      const bound = model.bindTools(
        tools.map((t) =>
          tool(async () => "", {
            name: t.name,
            description: t.description,
            schema: t.schema,
          })
        )
      );
      const byName = new Map(tools.map((t) => [t.name, t]));
      const invokeOpts =
        context?.signal !== undefined ? { signal: context.signal } : undefined;
      const messages: BaseMessage[] = [
        new SystemMessage(prompt.system),
        new HumanMessage(prompt.user),
      ];

      for (let step = 0; step < opts.maxSteps; step++) {
        const reply = await bound
          .invoke(messages, invokeOpts)
          .catch((error: Error) => handleLangchainError(error));
        messages.push(reply);
        if (!reply.tool_calls?.length) return reply.text;

        for (const toolCall of reply.tool_calls) {
          const t = byName.get(toolCall.name);
          const content = t
            ? await t
                .run(toolCall.args, context)
                .catch((error: Error) => `Tool error: ${error.message}`)
            : `Unknown tool: ${toolCall.name}`;
          messages.push(
            new ToolMessage({
              content,
              tool_call_id: toolCall.id ?? toolCall.name,
            })
          );
        }
      }

      // Budget spent: answer without tools.
      messages.push(
        new HumanMessage(
          "Tool budget exhausted. Write your final answer now, without tools."
        )
      );
      const final = await model
        .invoke(messages, invokeOpts)
        .catch((error: Error) => handleLangchainError(error));
      return final.text;
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
