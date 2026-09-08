// Exercises `resolveAllFragments` directly against fake providers — no
// graph, no LLM, no filesystem — plus `createMedicalBasisRegistry`'s shape.
import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "@/core/graph/utils/context.js";
import { createMedicalBasisRegistry, resolveAllFragments } from "./registry.js";
import { renderMedicalBasisSection } from "./render.js";
import type {
  BasisFragment,
  BasisQuery,
  MedicalBasisProvider,
} from "./ports.js";
import type { SymptomsRepo } from "@/core/graph/symptoms/repo.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import { InMemoryProcedureCatalog } from "@/core/graph/catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "@/core/graph/catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "@/core/graph/catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "@/core/graph/catalog/diagnosis/index.js";

const query: BasisQuery = {
  diagnosis: { name: "Influenza", icd: "1E32" },
  difficulty: "medium",
};

function fragment(sourceId: string, content = sourceId): BasisFragment {
  return {
    sourceId,
    label: sourceId,
    content,
    retrievedAt: "2024-01-01T00:00:00.000Z",
  };
}

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A provider that resolves after `delayMs`, optionally throwing instead. */
function makeStaggeredProvider(opts: {
  id: string;
  delayMs: number;
  throws?: boolean;
  hangsUntilAborted?: boolean;
}): MedicalBasisProvider {
  return {
    id: opts.id,
    async fetch(_query, context) {
      if (opts.hangsUntilAborted) {
        return new Promise<BasisFragment[]>((_resolve, reject) => {
          context?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
      }
      await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.throws) throw new Error(`${opts.id} blew up`);
      return [fragment(opts.id)];
    },
  };
}

describe("resolveAllFragments", () => {
  it("calls every provider and concatenates their fragments", async () => {
    const a: MedicalBasisProvider = {
      id: "a",
      fetch: async () => [fragment("a")],
    };
    const b: MedicalBasisProvider = {
      id: "b",
      fetch: async () => [fragment("b")],
    };

    const result = await resolveAllFragments([a, b], query, fakeLog());

    expect(result.map((f) => f.sourceId)).toEqual(["a", "b"]);

    const rendered = renderMedicalBasisSection(result) ?? "";
    expect(rendered).toContain("source: a");
    expect(rendered).toContain("source: b");
  });

  it("orders fragments by REGISTRY order, not completion order — the slow provider is first in the registry and resolves last", async () => {
    const slowButFirst = makeStaggeredProvider({ id: "slow", delayMs: 30 });
    const fastButSecond = makeStaggeredProvider({ id: "fast", delayMs: 0 });

    const result = await resolveAllFragments(
      [slowButFirst, fastButSecond],
      query,
      fakeLog()
    );

    // If this were completion order, "fast" would land first.
    expect(result.map((f) => f.sourceId)).toEqual(["slow", "fast"]);
  });

  it("logs and skips a provider that throws — the other provider's fragment still lands", async () => {
    const throwing = makeStaggeredProvider({
      id: "bad",
      delayMs: 0,
      throws: true,
    });
    const good: MedicalBasisProvider = {
      id: "good",
      fetch: async () => [fragment("good")],
    };
    const log = fakeLog();

    const result = await resolveAllFragments([throwing, good], query, log);

    expect(result.map((f) => f.sourceId)).toEqual(["good"]);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toContain("bad");
  });

  it("hands the provider the whole RequestContext, not just its signal", async () => {
    // Under ALLOW_LLMS the request's `llmConfig` is the only source of
    // provider/model, so a provider that makes an LLM call (as the UMLS one
    // does on a cold cache miss) is broken without it. The signal-only
    // signature issue 14 sketched would have been a silent regression.
    const seen: (RequestContext | undefined)[] = [];
    const recorder: MedicalBasisProvider = {
      id: "recorder",
      fetch: async (_query, context) => {
        seen.push(context);
        return [fragment("recorder")];
      },
    };
    const context: RequestContext = {
      jobId: "job-1",
      llmConfig: { provider: "ollama", model: "llama3.1" },
    };

    await resolveAllFragments([recorder], query, fakeLog(), context);

    expect(seen).toEqual([context]);
  });

  it("aborts a hanging provider via the request signal", async () => {
    const controller = new AbortController();
    const hanging = makeStaggeredProvider({
      id: "hangs",
      delayMs: 0,
      hangsUntilAborted: true,
    });
    const log = fakeLog();

    const promise = resolveAllFragments([hanging], query, log, {
      signal: controller.signal,
    });

    controller.abort();
    const result = await promise;

    expect(result).toEqual([]);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array for an empty registry, with zero provider calls", async () => {
    const result = await resolveAllFragments([], query, fakeLog());
    expect(result).toEqual([]);
  });
});

describe("createMedicalBasisRegistry", () => {
  it("returns exactly the UMLS symptom provider today", () => {
    const symptomsRepo: SymptomsRepo = {
      SymptomsRelatedToDiagnosisIcd: () => [],
      getCachedSymptoms: () => undefined,
      saveCachedSymptoms: () => {},
    };
    const runtime: GraphRuntime = {
      llm: {
        for() {
          throw new Error("not used in this test");
        },
      },
      catalogs: {
        procedures: new InMemoryProcedureCatalog(),
        anamnesis: new InMemoryAnamnesisCatalog(),
        labels: new InMemoryLabelCatalog(),
        diagnosis: new InMemoryDiagnosisCatalog(),
      },
      log: fakeLog(),
      clock: () => new Date("2024-01-01T00:00:00.000Z"),
    };

    const registry = createMedicalBasisRegistry({ runtime, symptomsRepo });

    expect(registry).toHaveLength(1);
    expect(registry[0].id).toBe("umls-symptoms");
  });
});
