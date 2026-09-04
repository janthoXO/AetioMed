// Reproduces the former `01symptom/` node's behaviour test-for-test, now
// through the `MedicalBasisProvider` port: UMLS floor + cache-aside LLM
// additions, same TTL semantics, a fresh cache hit skips the LLM entirely,
// and a diagnosis without an ICD code is never cached.
import { describe, expect, it, vi } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { createUmlsSymptomProvider } from "./umlsSymptoms.js";
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

/** Throws immediately — used to prove "zero LLM calls" tests really are. */
function makeThrowingLlmPort(): LlmPort {
  return {
    for() {
      throw new Error("umlsSymptoms.test: the LLM must not be called here.");
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
          throw new Error("umlsSymptoms.test: no more scripted responses.");
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

describe("createUmlsSymptomProvider", () => {
  it("id is 'umls-symptoms'", () => {
    const { repo } = makeFakeSymptomsRepo({});
    const provider = createUmlsSymptomProvider(
      buildRuntime(makeThrowingLlmPort()),
      repo
    );
    expect(provider.id).toBe("umls-symptoms");
  });

  it("a fresh cache hit unions the UMLS floor with the cache and makes ZERO LLM calls", async () => {
    const { repo } = makeFakeSymptomsRepo({
      umlsByIcd: { "1E32": [{ name: "Fever" }] },
      cachedByIcd: { "1E32": [{ name: "Chills" }] },
    });
    const runtime = buildRuntime(makeThrowingLlmPort());
    const provider = createUmlsSymptomProvider(runtime, repo);

    const fragments = await provider.fetch(query);

    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toEqual({
      sourceId: "umls-symptoms",
      label: "Typical symptoms",
      content: "Fever, Chills",
      retrievedAt: "2024-06-01T00:00:00.000Z",
    });
  });

  it("a cache miss calls the LLM exactly once, excludes the UMLS floor, and writes the result back to the cache", async () => {
    const { repo, saved } = makeFakeSymptomsRepo({
      umlsByIcd: { "1E32": [{ name: "Fever" }] },
      cachedByIcd: {},
    });
    const { llm, callCount } = makeQueuedLlmPort([
      JSON.stringify({ symptoms: [{ name: "Myalgia" }] }),
    ]);
    const runtime = buildRuntime(llm);
    const provider = createUmlsSymptomProvider(runtime, repo);

    const fragments = await provider.fetch(query);

    expect(callCount()).toBe(1);
    expect(fragments[0].content).toBe("Fever, Myalgia");
    expect(saved).toEqual([{ icd: "1E32", symptoms: [{ name: "Myalgia" }] }]);
  });

  it("a diagnosis without an ICD code is never cached, but the LLM is still called", async () => {
    const { repo, saved } = makeFakeSymptomsRepo({});
    const { llm, callCount } = makeQueuedLlmPort([
      JSON.stringify({ symptoms: [{ name: "Malaise" }] }),
    ]);
    const runtime = buildRuntime(llm);
    const provider = createUmlsSymptomProvider(runtime, repo);

    const fragments = await provider.fetch({
      diagnosis: { name: "Unspecified illness" },
      difficulty: "medium",
    });

    expect(callCount()).toBe(1);
    expect(saved).toEqual([]);
    expect(fragments[0].content).toBe("Malaise");
  });

  it("emits exactly one fragment even when there are no symptoms at all", async () => {
    const { repo } = makeFakeSymptomsRepo({
      umlsByIcd: {},
      cachedByIcd: { "1E32": [] },
    });
    const runtime = buildRuntime(makeThrowingLlmPort());
    const provider = createUmlsSymptomProvider(runtime, repo);

    const fragments = await provider.fetch(query);

    expect(fragments).toHaveLength(1);
    expect(fragments[0].content).toBe("");
  });
});
