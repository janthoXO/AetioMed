// Proves the whole point of the seam: a `GraphRuntime` built entirely from
// fakes — no real LLM, no filesystem, no SQLite — can run an actual graph
// node (the tool a LangGraph node calls into) and observe its LLM call
// count. No repo/persistence import, no network.
import { describe, expect, it } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import type { GraphRuntime, LlmPort } from "@/core/graph/runtime.js";
import { InMemoryProcedureCatalog } from "@/core/graph/catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "@/core/graph/catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "@/core/graph/catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "@/core/graph/catalog/diagnosis/index.js";
import { translateDiagnosisToEnglish } from "@/core/graph/02graphs/01case-translation-to-english/tools.js";

/** Counts every `chat()` call and returns a canned JSON response each time. */
function makeCountingFakeLlmPort(response: string): {
  llm: LlmPort;
  callCount: () => number;
} {
  let calls = 0;
  return {
    llm: {
      chat() {
        calls++;
        return new FakeListChatModel({ responses: [response] });
      },
    },
    callCount: () => calls,
  };
}

function buildFakeRuntime(llm: LlmPort): GraphRuntime {
  return {
    llm,
    catalogs: {
      procedures: new InMemoryProcedureCatalog(),
      anamnesis: new InMemoryAnamnesisCatalog(),
      labels: new InMemoryLabelCatalog(),
      diagnosis: new InMemoryDiagnosisCatalog(),
    },
    log: { info() {}, warn() {}, error() {} },
    clock: () => new Date("2024-01-01T00:00:00.000Z"),
  };
}

describe("GraphRuntime with a fake LlmPort", () => {
  it("running a node's tool calls the fake LLM exactly once on a cache miss", async () => {
    const { llm, callCount } = makeCountingFakeLlmPort(
      '{"diagnosis":"Influenza"}'
    );
    const runtime = buildFakeRuntime(llm);

    const result = await translateDiagnosisToEnglish.invoke(
      { diagnosis: { name: "Grippe" }, language: "German" },
      runtime
    );

    expect(result.name).toBe("Influenza");
    expect(callCount()).toBe(1);

    // The translation is now cached on the InMemoryDiagnosisCatalog — a
    // second call for the same key must not call the LLM again.
    const cached = runtime.catalogs.diagnosis.toEnglish("Grippe", "German");
    expect(cached).toBe("Influenza");
  });
});
