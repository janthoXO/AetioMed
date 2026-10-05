// `userInstructions` translated to English alongside `diagnosis`.
import { chatModelLlmPort } from "@/adapters/ai/llm.js";
import { describe, expect, it } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { translateUserInstructionsToEnglish } from "./gateway.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

function fakeRuntime(responseJson: string): GraphRuntime {
  return {
    llm: chatModelLlmPort(
      () => new FakeListChatModel({ responses: [responseJson] })
    ),
    log: { info() {}, warn() {}, error() {} },
    clock: () => new Date("2024-01-01T00:00:00.000Z"),
  } as unknown as GraphRuntime;
}

describe("translateUserInstructionsToEnglish", () => {
  it("translates every value, keyed by the instructions' own keys (not by text)", async () => {
    const runtime = fakeRuntime(
      JSON.stringify({
        general: "Keep it simple.",
        procedures: "Order only obligatory tests.",
      })
    );

    const result = await translateUserInstructionsToEnglish(runtime, {
      userInstructions: {
        general: "Halte es einfach.",
        procedures: "Bestelle nur obligatorische Tests.",
      },
      language: "German",
    });

    expect(result).toEqual({
      general: "Keep it simple.",
      procedures: "Order only obligatory tests.",
    });
  });

  it("returns {} and never calls the LLM for empty userInstructions", async () => {
    const throwingRuntime = {
      llm: chatModelLlmPort(() => {
        throw new Error("Unexpected LLM call");
      }),
      log: { info() {}, warn() {}, error() {} },
      clock: () => new Date("2024-01-01T00:00:00.000Z"),
    } as unknown as GraphRuntime;

    const result = await translateUserInstructionsToEnglish(throwingRuntime, {
      userInstructions: {},
      language: "German",
    });

    expect(result).toEqual({});
  });
});
