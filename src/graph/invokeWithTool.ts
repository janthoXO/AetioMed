import { createAgent, HumanMessage, type CreateAgentParams } from "langchain";

export async function invokeWithTools(
  agentConfig: CreateAgentParams,
  userMessages: HumanMessage[]
): Promise<string> {
  const agent = createAgent(agentConfig);

  const result = await agent.invoke({ messages: userMessages });

  if (agentConfig.responseFormat) {
    return JSON.stringify(result.structuredResponse);
  }
  return result.messages[result.messages.length - 1]!.content as string;
}
