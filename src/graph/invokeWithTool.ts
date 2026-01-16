import { createAgent, HumanMessage, type CreateAgentParams } from "langchain";

export async function invokeWithTools(
  agentConfig: CreateAgentParams,
  userMessages: HumanMessage[]
): Promise<string> {
  const agent = createAgent(agentConfig);

  const result = await agent.invoke({ messages: userMessages });

  if (agentConfig.responseFormat) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const structured = (result as any).structuredResponse;
    if (structured) {
      return JSON.stringify(structured);
    }

    // Fallback: If structuredResponse is missing, check content
  }

  return result.messages[result.messages.length - 1]!.content as string;
}
