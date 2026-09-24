// Plan mode's outline translation: two single-node graphs. Tests drive compiled graphs
// (`buildOutlineTranslationGraph`) with fake LLM; style of `03case-translation-from-english/index.test.ts`.
import { describe, expect, it } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  buildOutlineTranslationGraph,
  translateOutlineValues,
} from "./index.js";
import type { GraphRuntime, LlmPort } from "@/core/graph/runtime.js";
import { runWithContext } from "@/core/graph/utils/context.js";
import {
  createTraceNode,
  getNodeLabels,
} from "@/core/graph/utils/nodeWrapper.js";
import { EventBus } from "@/core/event-bus.js";

/** An LLM serving one scripted JSON response, regardless of role/prompt. */
function fakeRuntime(response: Record<string, string>): {
  runtime: GraphRuntime;
  calls: { count: number };
} {
  const calls = { count: 0 };
  const runtime = {
    llm: {
      for: () => {
        calls.count++;
        return new FakeListChatModel({ responses: [JSON.stringify(response)] });
      },
    } as unknown as LlmPort,
    catalogs: {
      procedures: undefined,
      anamnesis: undefined,
      labels: undefined,
      diagnosis: undefined,
    },
    log: { info() {}, warn() {}, error() {} },
    clock: () => new Date("2024-01-01T00:00:00.000Z"),
  } as unknown as GraphRuntime;
  return { runtime, calls };
}

describe("buildOutlineTranslationGraph — direction out", () => {
  it("translates non-empty values and passes empty ones through without an LLM call", async () => {
    const { runtime, calls } = fakeRuntime({
      "0": "Überschrift",
      "1": "# Vorgeschichte",
    });
    const graph = buildOutlineTranslationGraph(
      runtime,
      createTraceNode(new EventBus()),
      "out"
    );

    const result = await runWithContext(
      () =>
        translateOutlineValues(graph, {
          "0": "Heading",
          "1": "# History",
          "2": "   ",
          "3": "",
        }),
      undefined,
      undefined,
      "German"
    );

    expect(result).toEqual({
      "0": "Überschrift",
      "1": "# Vorgeschichte",
      "2": "   ",
      "3": "",
    });
    expect(calls.count).toBe(1);
  });

  it("makes zero LLM calls when all values are empty", async () => {
    const { runtime, calls } = fakeRuntime({});
    const graph = buildOutlineTranslationGraph(
      runtime,
      createTraceNode(new EventBus()),
      "out"
    );

    const result = await runWithContext(
      () => translateOutlineValues(graph, { "0": "", "1": "   " }),
      undefined,
      undefined,
      "German"
    );

    expect(result).toEqual({ "0": "", "1": "   " });
    expect(calls.count).toBe(0);
  });

  it("throws when no language is bound on the request context", async () => {
    const { runtime } = fakeRuntime({ "0": "x" });
    const graph = buildOutlineTranslationGraph(
      runtime,
      createTraceNode(new EventBus()),
      "out"
    );

    await expect(
      runWithContext(() => translateOutlineValues(graph, { "0": "Heading" }))
    ).rejects.toThrow(/language bound/);
  });

  it("uses node id translate_outline_out with label 'Translating case outline'", () => {
    buildOutlineTranslationGraph(
      { llm: {} } as unknown as GraphRuntime,
      createTraceNode(new EventBus()),
      "out"
    );
    expect(getNodeLabels()["translate_outline_out"]).toBe(
      "Translating case outline"
    );
  });
});

describe("buildOutlineTranslationGraph — direction in", () => {
  it("translates the reviewed outline to English", async () => {
    const { runtime, calls } = fakeRuntime({
      "0": "Chief complaint",
    });
    const graph = buildOutlineTranslationGraph(
      runtime,
      createTraceNode(new EventBus()),
      "in"
    );

    const result = await runWithContext(
      () => translateOutlineValues(graph, { "0": "Hauptbeschwerde" }),
      undefined,
      undefined,
      "German"
    );

    expect(result).toEqual({ "0": "Chief complaint" });
    expect(calls.count).toBe(1);
  });

  it("uses node id translate_review_in with label 'Translating reviewed outline to English'", () => {
    buildOutlineTranslationGraph(
      { llm: {} } as unknown as GraphRuntime,
      createTraceNode(new EventBus()),
      "in"
    );
    expect(getNodeLabels()["translate_review_in"]).toBe(
      "Translating reviewed outline to English"
    );
  });
});
