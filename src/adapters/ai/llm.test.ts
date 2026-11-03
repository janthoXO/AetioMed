import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ModelUnreachableError } from "@/core/graph/errors/AppError.js";
import type { Config } from "@/core/graph/config.js";
import { chatModelLlmPort, createLlmPort } from "./llm.js";

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
    expect(withStructuredOutput).toHaveBeenCalledWith({
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    });
    const [messages, options] = invoke.mock.calls[0]!;
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(messages[0].content).toBe("sys");
    expect(messages[1]).toBeInstanceOf(HumanMessage);
    expect(messages[1].content).toBe("usr");
    expect(options).toEqual({ signal });
  });

  it("structured: wraps a non-object root as { value } and unwraps the answer", async () => {
    const invoke = vi.fn().mockResolvedValue({ value: { kind: "b" } });
    const { port, withStructuredOutput } = fakePort(invoke);
    const schema = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("a") }),
      z.object({ kind: z.literal("b") }),
    ]);

    await expect(port.structured(call, prompt, schema)).resolves.toEqual({
      kind: "b",
    });
    const sent = withStructuredOutput.mock.calls[0]![0];
    expect(sent.required).toEqual(["value"]);
    expect(sent.properties.value.anyOf[1].properties.kind).toEqual({
      type: "string",
      enum: ["b"],
    });
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
});

describe("createLlmPort", () => {
  it("never logs the API key", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const port = createLlmPort({} as Config);
    await port
      .text(call, prompt, {
        llmConfig: {
          provider: "openai",
          model: "m",
          apiKey: "sk-secret",
          url: "http://127.0.0.1:1",
        },
        signal: AbortSignal.abort(),
      })
      .catch(() => {});
    expect(debug).toHaveBeenCalled();
    expect(JSON.stringify(debug.mock.calls)).not.toContain("sk-secret");
    debug.mockRestore();
  });

  it.each([
    {
      provider: "openai" as const,
      sent: (body: Record<string, unknown>) => body.response_format,
      expected: { type: "json_schema", json_schema: { strict: true } },
    },
    {
      provider: "google" as const,
      sent: (body: Record<string, unknown>) => body.generationConfig,
      expected: { responseJsonSchema: { required: ["ok"] } },
    },
  ])(
    "$provider: asks for native strict structured output with the portable schema",
    async ({ provider, sent, expected }) => {
      vi.spyOn(console, "debug").mockImplementation(() => {});
      const bodies: Record<string, unknown>[] = [];
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          // OpenAI passes (url, init); @langchain/google a Request.
          const body = init?.body ?? (await (input as Request).clone().text());
          bodies.push(JSON.parse(String(body)));
          return new Response('{"error":{"message":"stub"}}', { status: 400 });
        });

      await createLlmPort({} as Config)
        .structured(call, prompt, z.object({ ok: z.boolean() }), {
          llmConfig: { provider, model: "m", apiKey: "k" },
        })
        .catch(() => {});

      expect(sent(bodies[0]!)).toMatchObject(expected);
      fetch.mockRestore();
      vi.mocked(console.debug).mockRestore();
    }
  );

  it("ollama: the structured call's schema overrides the constructor's format json", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const formats: unknown[] = [];
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) => {
        formats.push(JSON.parse(String(init?.body)).format);
        return new Response(
          JSON.stringify({
            model: "m",
            created_at: new Date().toISOString(),
            message: { role: "assistant", content: '{"ok":true}' },
            done: true,
          }) + "\n"
        );
      });
    const port = createLlmPort({} as Config);
    const llmConfig = {
      provider: "ollama",
      model: "m",
      url: "http://ollama.test",
    } as const;

    await port.structured(call, prompt, z.object({ ok: z.boolean() }), {
      llmConfig,
    });
    await port.text(call, prompt, { llmConfig });

    expect(formats[0]).toMatchObject({
      properties: { ok: { type: "boolean" } },
    });
    expect(formats[1]).toBeUndefined();
    fetch.mockRestore();
    vi.mocked(console.debug).mockRestore();
  });
});
