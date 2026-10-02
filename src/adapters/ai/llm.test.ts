import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ModelUnreachableError } from "@/core/graph/errors/AppError.js";
import { chatModelLlmPort } from "./llm.js";

function fakePort(invoke: ReturnType<typeof vi.fn>) {
  const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
  const model = { withStructuredOutput, invoke } as unknown as BaseChatModel;
  const modelFor = vi.fn().mockReturnValue(model);
  return { port: chatModelLlmPort(modelFor), modelFor, withStructuredOutput };
}

const call = { role: "judge", temperature: "deterministic" } as const;
const prompt = { system: "sys", user: "usr" };

describe("chatModelLlmPort", () => {
  it("structured: passes messages in order, schema, signal and llmConfig", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const { port, modelFor, withStructuredOutput } = fakePort(invoke);
    const schema = z.object({ ok: z.boolean() });
    const signal = new AbortController().signal;
    const llmConfig = { provider: "ollama", model: "m" } as const;

    const result = await port.structured(call, prompt, schema, {
      llmConfig,
      signal,
    });

    expect(result).toEqual({ ok: true });
    expect(modelFor).toHaveBeenCalledWith(call, llmConfig);
    expect(withStructuredOutput).toHaveBeenCalledWith(schema);
    const [messages, options] = invoke.mock.calls[0]!;
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(messages[0].content).toBe("sys");
    expect(messages[1]).toBeInstanceOf(HumanMessage);
    expect(messages[1].content).toBe("usr");
    expect(options).toEqual({ signal });
  });

  it("structured: maps a fetch failure to ModelUnreachableError", async () => {
    const { port } = fakePort(
      vi.fn().mockRejectedValue(new Error("fetch failed"))
    );
    await expect(
      port.structured(call, prompt, z.object({}))
    ).rejects.toBeInstanceOf(ModelUnreachableError);
  });

  it("text: asks for outputFormat text and returns the message text", async () => {
    const invoke = vi.fn().mockResolvedValue(new AIMessage("hello"));
    const { port, modelFor, withStructuredOutput } = fakePort(invoke);

    const result = await port.text(call, prompt, {
      llmConfig: { model: "m" },
    });

    expect(result).toBe("hello");
    expect(modelFor).toHaveBeenCalledWith(call, {
      model: "m",
      outputFormat: "text",
    });
    expect(withStructuredOutput).not.toHaveBeenCalled();
    expect(invoke.mock.calls[0]![1]).toBeUndefined();
  });

  it("agent: runs tool calls, feeds results back, returns final text", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(
        new AIMessage({
          content: "",
          tool_calls: [{ id: "1", name: "web_search", args: { query: "q" } }],
        })
      )
      .mockResolvedValueOnce(new AIMessage("outline"));
    const model = {
      bindTools: vi.fn().mockReturnValue({ invoke }),
      invoke,
    } as unknown as BaseChatModel;
    const port = chatModelLlmPort(() => model);
    const run = vi.fn().mockResolvedValue("result text");

    const result = await port.agent(
      call,
      prompt,
      [{ name: "web_search", description: "d", schema: z.object({}), run }],
      { maxSteps: 3 }
    );

    expect(result).toBe("outline");
    expect(run).toHaveBeenCalledWith({ query: "q" }, undefined);
    // [system, human, tool call, tool result, final]; array shared by reference.
    const toolResult = invoke.mock.calls[1]![0][3];
    expect(toolResult).toBeInstanceOf(ToolMessage);
    expect(toolResult.content).toBe("result text");
  });
});
