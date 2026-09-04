// Proves the whole point of the seam: a `GraphRuntime` built entirely from
// fakes — no real LLM, no filesystem, no SQLite — can run an actual graph
// node (the tool a LangGraph node calls into) and observe its LLM call
// count. No repo/persistence import, no network.
import { describe, expect, it } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import type { GraphRuntime, LlmPort, LlmRole } from "@/core/graph/runtime.js";
import { InMemoryProcedureCatalog } from "@/core/graph/catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "@/core/graph/catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "@/core/graph/catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "@/core/graph/catalog/diagnosis/index.js";
import { translateDiagnosisToEnglish } from "@/core/graph/02graphs/01case-translation-to-english/tools.js";
import { ConfigSchema, type Config } from "@/core/graph/config.js";
import { evaluateOutline } from "@/core/graph/03aigateway/outlineEvaluation.aigateway.js";
import { generateSymptomsOneShot } from "@/core/graph/03aigateway/symptoms.aigateway.js";

/** Counts every `chat()` call and returns a canned JSON response each time. */
function makeCountingFakeLlmPort(response: string): {
  llm: LlmPort;
  callCount: () => number;
} {
  let calls = 0;
  return {
    llm: {
      for() {
        calls++;
        return new FakeListChatModel({ responses: [response] });
      },
    },
    callCount: () => calls,
  };
}

/**
 * Mirrors `createLlmPort`'s resolution order (per-call `llmConfig` overrides
 * the role's resolved default) without any real network/provider — so this
 * proves role plumbing end to end (config resolution through to the exact
 * call site), not just that a role string got passed somewhere.
 */
function makeRoleAwareFakeLlmPort(
  config: Config,
  responses: Partial<Record<LlmRole, string>>
): { llm: LlmPort; calls: { role: LlmRole; model: string }[] } {
  const calls: { role: LlmRole; model: string }[] = [];
  return {
    llm: {
      for(opts, llmConfig) {
        const roleConfig = config.llmRoles?.[opts.role];
        const model = llmConfig?.model ?? roleConfig?.model ?? "unresolved";
        calls.push({ role: opts.role, model });
        return new FakeListChatModel({
          responses: [responses[opts.role] ?? "{}"],
        });
      },
    },
    calls,
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

  it("with LLM_JUDGE_* set, judge calls use the judge model and generator calls do not", async () => {
    const config = ConfigSchema.parse({
      LLM_PROVIDER: "ollama",
      LLM_MODEL: "general-model",
      LLM_JUDGE_MODEL: "judge-model",
    });

    const { llm, calls } = makeRoleAwareFakeLlmPort(config, {
      judge: JSON.stringify({ accepted: true, reasons: [] }),
      generator: JSON.stringify({ symptoms: [{ name: "fever" }] }),
    });
    const runtime = buildFakeRuntime(llm);

    await evaluateOutline(
      runtime,
      { name: "Influenza" },
      "Some blueprint",
      "medium"
    );
    await generateSymptomsOneShot(runtime, { name: "Influenza" });

    // Both directions: the judge call used the judge's own model, and the
    // generator call — despite running after it — was not contaminated by
    // it and used the general model instead.
    expect(calls).toEqual([
      { role: "judge", model: "judge-model" },
      { role: "generator", model: "general-model" },
    ]);
  });
});
