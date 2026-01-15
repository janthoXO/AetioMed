import { createAgent, HumanMessage, type CreateAgentParams } from "langchain";

export async function invokeWithTools(
  agentConfig: CreateAgentParams,
  userMessages: HumanMessage[]
): Promise<string> {
  const agent = createAgent(agentConfig);

  const result = await agent.invoke({ messages: userMessages });

  if (agentConfig.responseFormat) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return JSON.stringify((result as any).structuredResponse);
  }
  return result.messages[result.messages.length - 1]!.content as string;
}
