import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { InteropZodObject } from "@langchain/core/utils/types";
import {
  createAgent,
  HumanMessage,
  StructuredTool,
  type AgentMiddleware,
} from "langchain";

export type AgentConfig = {
  model: BaseChatModel;
  tools: StructuredTool[];
  systemPrompt: string;
  responseFormat?: InteropZodObject;
  middleware?: AgentMiddleware[];
};

export async function invokeWithTools(
  agentConfig: AgentConfig,
  userMessages: HumanMessage[]
): Promise<string> {
  const agent = createAgent(agentConfig);

  const result = await agent.invoke({ messages: userMessages });

  return result.messages[result.messages.length - 1]!.text;
}
