// `GraphRuntime` built from fakes only (no LLM, fs, SQLite, network) can run a
// graph node's tool and count LLM calls.
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

/** Mirrors `createLlmPort` resolution (per-call `llmConfig` overrides role default), no network. */
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

    // Cached on InMemoryDiagnosisCatalog.
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

    // Judge uses judge model; later generator call still uses general model.
    expect(calls).toEqual([
      { role: "judge", model: "judge-model" },
      { role: "generator", model: "general-model" },
    ]);
  });
});
