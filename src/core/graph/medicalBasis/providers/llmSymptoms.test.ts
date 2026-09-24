// LLM fallback for `umls-symptoms`: only runs when UMLS has nothing for the ICD code; cache-aside.
import { describe, expect, it, vi } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { createLlmSymptomProvider } from "./llmSymptoms.js";
import type { SymptomsRepo } from "@/core/graph/symptoms/repo.js";
import type { Symptom } from "@/core/graph/models/Symptom.js";
import type { GraphRuntime, LlmPort } from "@/core/graph/runtime.js";
import { InMemoryProcedureCatalog } from "@/core/graph/catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "@/core/graph/catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "@/core/graph/catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "@/core/graph/catalog/diagnosis/index.js";
import type { BasisQuery } from "../ports.js";

function makeFakeSymptomsRepo(opts: {
  umlsByIcd?: Record<string, Symptom[]>;
  cachedByIcd?: Record<string, Symptom[]>;
}) {
  const saved: { icd: string; symptoms: Symptom[] }[] = [];
  const repo: SymptomsRepo = {
    SymptomsRelatedToDiagnosisIcd: (icd) => opts.umlsByIcd?.[icd] ?? [],
    getCachedSymptoms: (icd) => opts.cachedByIcd?.[icd],
    saveCachedSymptoms: (icd, symptoms) => {
      saved.push({ icd, symptoms });
    },
  };
  return { repo, saved };
}

/** Throws immediately: proves zero-LLM-call paths. */
function makeThrowingLlmPort(): LlmPort {
  return {
    for() {
      throw new Error("llmSymptoms.test: the LLM must not be called here.");
    },
  };
}

function makeQueuedLlmPort(responses: string[]): {
  llm: LlmPort;
  callCount: () => number;
} {
  const queue = [...responses];
  let calls = 0;
  return {
    llm: {
      for() {
        calls++;
        const response = queue.shift();
        if (response === undefined) {
          throw new Error("llmSymptoms.test: no more scripted responses.");
        }
        return new FakeListChatModel({ responses: [response] });
      },
    },
    callCount: () => calls,
  };
}

function buildRuntime(llm: LlmPort): GraphRuntime {
  return {
    llm,
    catalogs: {
      procedures: new InMemoryProcedureCatalog(),
      anamnesis: new InMemoryAnamnesisCatalog(),
      labels: new InMemoryLabelCatalog(),
      diagnosis: new InMemoryDiagnosisCatalog(),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    clock: () => new Date("2024-06-01T00:00:00.000Z"),
  };
}

const query: BasisQuery = {
  diagnosis: { name: "Influenza", icd: "1E32" },
  difficulty: "medium",
};

describe("createLlmSymptomProvider", () => {
  it("id is 'llm-symptoms'", () => {
    const { repo } = makeFakeSymptomsRepo({});
    const provider = createLlmSymptomProvider(
      buildRuntime(makeThrowingLlmPort()),
      repo
    );
    expect(provider.id).toBe("llm-symptoms");
  });

  it("UMLS has data for the ICD code: undefined, zero LLM calls, no cache write", async () => {
    const { repo, saved } = makeFakeSymptomsRepo({
      umlsByIcd: { "1E32": [{ name: "Fever" }] },
    });
    const { llm, callCount } = makeQueuedLlmPort([]);
    const provider = createLlmSymptomProvider(buildRuntime(llm), repo);

    const result = await provider.fetch(query);

    expect(result).toBeUndefined();
    expect(callCount()).toBe(0);
    expect(saved).toEqual([]);
  });

  it("a fresh cache hit returns the cached names with zero LLM calls", async () => {
    const { repo, saved } = makeFakeSymptomsRepo({
      umlsByIcd: {},
      cachedByIcd: { "1E32": [{ name: "Chills" }, { name: "Myalgia" }] },
    });
    const provider = createLlmSymptomProvider(
      buildRuntime(makeThrowingLlmPort()),
      repo
    );

    const result = await provider.fetch(query);

    expect(result).toBe("Chills, Myalgia");
    expect(saved).toEqual([]);
  });

  it("a cache miss calls the LLM exactly once and saves the result to the cache", async () => {
    const { repo, saved } = makeFakeSymptomsRepo({
      umlsByIcd: {},
      cachedByIcd: {},
    });
    const { llm, callCount } = makeQueuedLlmPort([
      JSON.stringify({ symptoms: [{ name: "Myalgia" }] }),
    ]);
    const provider = createLlmSymptomProvider(buildRuntime(llm), repo);

    const result = await provider.fetch(query);

    expect(callCount()).toBe(1);
    expect(result).toBe("Myalgia");
    expect(saved).toEqual([{ icd: "1E32", symptoms: [{ name: "Myalgia" }] }]);
  });

  it("no ICD code: LLM is called, nothing is cached", async () => {
    const { repo, saved } = makeFakeSymptomsRepo({});
    const { llm, callCount } = makeQueuedLlmPort([
      JSON.stringify({ symptoms: [{ name: "Malaise" }] }),
    ]);
    const provider = createLlmSymptomProvider(buildRuntime(llm), repo);

    const result = await provider.fetch({
      diagnosis: { name: "Unspecified illness" },
      difficulty: "medium",
    });

    expect(callCount()).toBe(1);
    expect(saved).toEqual([]);
    expect(result).toBe("Malaise");
  });

  it("an empty LLM result is undefined and not cached", async () => {
    const { repo, saved } = makeFakeSymptomsRepo({
      umlsByIcd: {},
      cachedByIcd: {},
    });
    const { llm } = makeQueuedLlmPort([JSON.stringify({ symptoms: [] })]);
    const provider = createLlmSymptomProvider(buildRuntime(llm), repo);

    const result = await provider.fetch(query);

    expect(result).toBeUndefined();
    expect(saved).toEqual([]);
  });
});
