// Assembly is pure wiring, so these tests need no LLM, no filesystem and no
// SQLite — just a minimal runtime and no-op repos, mirroring the stand-ins
// `exportGraphs.ts` already uses for the same reason.
import { describe, expect, it, vi } from "vitest";
import {
  ALL_GRAPH_FLAGS,
  assembleCaseGraph,
  buildCaseGraph,
  graphTopologyKey,
  graphVariantKey,
  type AssemblyDeps,
  type GraphFlags,
} from "./caseGraph.js";
import { EventBus } from "@/core/event-bus.js";
import { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { createLogger } from "@/core/graph/utils/logger.js";
import { runWithContext } from "@/core/graph/utils/context.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import { ConfigSchema } from "@/core/graph/config.js";
import { InMemoryProcedureCatalog } from "@/core/graph/catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "@/core/graph/catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "@/core/graph/catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "@/core/graph/catalog/diagnosis/index.js";
import type { AnamnesisRepo } from "@/core/graph/catalog/anamnesis/index.js";
import type { ProceduresRepo } from "@/core/graph/catalog/procedures/index.js";
import type { MedicalBasisProvider } from "@/core/graph/medicalBasis/ports.js";

const TRANSLATION_NODES = [
  "translation_to_english_phase",
  "translation_from_english_phase",
];

function buildDeps(
  medicalBasisRegistry: MedicalBasisProvider[] = [
    { id: "fake-basis", fetch: async () => [] },
  ]
): AssemblyDeps {
  const bus = new EventBus();
  const runtime: GraphRuntime = {
    llm: {
      for() {
        throw new Error("caseGraph.test: assembly must never call the LLM.");
      },
    },
    catalogs: {
      procedures: new InMemoryProcedureCatalog(),
      anamnesis: new InMemoryAnamnesisCatalog(),
      labels: new InMemoryLabelCatalog(),
      diagnosis: new InMemoryDiagnosisCatalog(),
    },
    log: createLogger(bus),
    clock: () => new Date("2024-01-01T00:00:00.000Z"),
  };

  const anamnesis: AnamnesisRepo = {
    translationsFile: "",
    getAnamnesisCategoryTranslationFromEnglish: () => undefined,
    saveAnamnesisCategoryTranslations: () => {},
    getEffectiveCategoryList: () => undefined,
  };
  const procedures: ProceduresRepo = {
    translationsFile: "",
    getProcedureNameTranslationFromEnglish: () => undefined,
    saveProcedureNameTranslation: () => {},
    getEffectiveProcedureList: () => undefined,
  };

  return {
    runtime,
    repos: { anamnesis, procedures },
    medicalBasisRegistry,
    traceNode: createTraceNode(bus),
  };
}

async function nodeIds(graph: {
  getGraphAsync: (opts: { xray: boolean }) => Promise<{
    nodes: Record<string, unknown>;
  }>;
}): Promise<string[]> {
  const drawn = await graph.getGraphAsync({ xray: true });
  return Object.keys(drawn.nodes).sort();
}

const flags = (
  translationSandwich: boolean,
  procedurePreselection: boolean
): GraphFlags => ({ translationSandwich, procedurePreselection });

describe("assembleCaseGraph", () => {
  it("is pure: the same (deps, flags) produce the same node set", async () => {
    const deps = buildDeps();
    const a = await nodeIds(assembleCaseGraph(deps, flags(true, false)));
    const b = await nodeIds(assembleCaseGraph(deps, flags(true, false)));

    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("omits the translation nodes entirely when the sandwich is off", async () => {
    const ids = await nodeIds(
      assembleCaseGraph(buildDeps(), flags(false, false))
    );

    for (const node of TRANSLATION_NODES) {
      expect(ids.some((id) => id.startsWith(node))).toBe(false);
    }
  });

  it("includes both translation nodes when the sandwich is on", async () => {
    const ids = await nodeIds(
      assembleCaseGraph(buildDeps(), flags(true, false))
    );

    for (const node of TRANSLATION_NODES) {
      expect(ids.some((id) => id.startsWith(node))).toBe(true);
    }
  });

  it("keeps the per-request `procedures` branch in every variant", async () => {
    // `generationFlags` is per-request, so the procedure phase must never be
    // compiled away — that is the other half of the compile-vs-branch rule.
    for (const f of ALL_GRAPH_FLAGS) {
      const ids = await nodeIds(assembleCaseGraph(buildDeps(), f));
      expect(
        ids.some((id) => id.includes("procedure_phase")),
        `procedure_phase missing from variant "${graphVariantKey(f)}"`
      ).toBe(true);
    }
  });

  it("compiles no basis_resolve node at all when the medical-basis registry is empty", async () => {
    const ids = await nodeIds(
      assembleCaseGraph(buildDeps([]), flags(false, false))
    );
    expect(ids.some((id) => id.includes("basis_resolve"))).toBe(false);
  });

  it("compiles a basis_resolve node when the medical-basis registry is non-empty", async () => {
    const ids = await nodeIds(
      assembleCaseGraph(
        buildDeps([{ id: "fake-basis", fetch: async () => [] }]),
        flags(false, false)
      )
    );
    expect(ids.some((id) => id.includes("basis_resolve"))).toBe(true);
  });

  it("gives the two preselection variants of a topology identical shapes", async () => {
    // This is the premise `exportGraphs.ts` rests on when it writes two
    // diagrams instead of four: PROCEDURE_PRESELECTION swaps a strategy
    // adapter, it does not change topology. If this ever fails, the export
    // loop needs to grow back to four.
    const deps = buildDeps();
    for (const sandwich of [false, true]) {
      const off = await nodeIds(
        assembleCaseGraph(deps, flags(sandwich, false))
      );
      const on = await nodeIds(assembleCaseGraph(deps, flags(sandwich, true)));
      expect(on).toEqual(off);
    }
  });
});

describe("language routing reads ALS, never graph state (issue 09 §2)", () => {
  // The fake runtime's `llm.for()` throws (see `buildDeps`), so a full
  // generation always fails partway through — that's fine here, we only
  // care which nodes started *before* the throw, via "Node Started" bus
  // events, not whether generation completes.
  async function startedNodes(opts: {
    /** Bound on ALS, via `runWithContext` — the real read path. */
    alsLanguage?: string;
    /** Passed as an (unschemad) extra key on the invoke input — must be a no-op. */
    stateLanguage?: string;
    /** Provenance for the translate-**in** edge (issue 12 §3). Defaults to
     * `true` so the pre-existing tests below, written before that trigger
     * existed, keep exercising the translate-in phase on a German request. */
    callerSuppliedFreeText?: boolean;
  }): Promise<string[]> {
    const bus = new EventBus();
    const started: string[] = [];
    bus.on("Node Started", (e) => started.push(e.node));

    const deps = { ...buildDeps(), traceNode: createTraceNode(bus) };
    const graph = assembleCaseGraph(deps, flags(true, false));

    await runWithContext(
      async () => {
        try {
          await graph.invoke({
            diagnosis: { name: "Influenza" },
            userInstructions: undefined,
            generationFlags: ["patient"],
            difficulty: "medium",
            case: {},
            callerSuppliedFreeText: opts.callerSuppliedFreeText ?? true,
            // Excess key: `CaseStateSchema` has no `language` field, so
            // LangGraph's input-channel filtering must drop this silently —
            // proving routing cannot be driven by state even if a caller
            // tried to.
            ...(opts.stateLanguage !== undefined
              ? { language: opts.stateLanguage }
              : {}),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any);
        } catch {
          // Expected: the fake LLM throws once real generation work starts.
        }
      },
      undefined,
      undefined,
      opts.alsLanguage
    );

    return started;
  }

  it("a German request bound on ALS enters the translate-to-English phase", async () => {
    const nodes = await startedNodes({ alsLanguage: "German" });
    expect(nodes).toContain("translate_diagnosis");
  });

  it("an English (default) request bound on ALS enters neither translation phase", async () => {
    const nodes = await startedNodes({ alsLanguage: undefined });
    expect(nodes).not.toContain("translate_diagnosis");
  });

  it("a `language` key on the invoke input has no effect — only ALS is read", async () => {
    // ALS says English (skip), state input says German — if routing ever
    // read state, this would translate; it must not.
    const nodes = await startedNodes({
      alsLanguage: undefined,
      stateLanguage: "German",
    });
    expect(nodes).not.toContain("translate_diagnosis");
  });
});

describe("translate-in trigger reads provenance, not just language (issue 12 §3)", () => {
  it("a German request with callerSuppliedFreeText enters translate-to-English", async () => {
    // Re-exercises the routing predicate directly (rather than relying on
    // the default in `startedNodes` above), naming the fix explicitly.
    const bus = new EventBus();
    const started: string[] = [];
    bus.on("Node Started", (e) => started.push(e.node));
    const deps = { ...buildDeps(), traceNode: createTraceNode(bus) };
    const graph = assembleCaseGraph(deps, flags(true, false));

    await runWithContext(
      async () => {
        try {
          await graph.invoke({
            diagnosis: { name: "Influenza" },
            generationFlags: ["patient"],
            difficulty: "medium",
            case: {},
            callerSuppliedFreeText: true,
          });
        } catch {
          // Expected: the fake LLM throws once real generation work starts.
        }
      },
      undefined,
      undefined,
      "German"
    );

    expect(started).toContain("translate_diagnosis");
  });

  it("an ICD-only German request (no free text) skips translate-to-English entirely and writes no identity translations", async () => {
    const bus = new EventBus();
    const started: string[] = [];
    bus.on("Node Started", (e) => started.push(e.node));

    const diagnosisCatalog = new InMemoryDiagnosisCatalog([
      { name: "Influenza", icd: "1E32" },
    ]);
    const saveTranslations = vi.spyOn(diagnosisCatalog, "saveTranslations");
    const deps = buildDeps();
    deps.runtime.catalogs.diagnosis = diagnosisCatalog;
    const graph = assembleCaseGraph(
      { ...deps, traceNode: createTraceNode(bus) },
      flags(true, false)
    );

    await runWithContext(
      async () => {
        try {
          await graph.invoke({
            // Resolved from the icd by `CaseGenerationService` before the
            // graph ever runs — already the catalogue's English name.
            diagnosis: { name: "Influenza", icd: "1E32" },
            generationFlags: ["patient"],
            difficulty: "medium",
            case: {},
            callerSuppliedFreeText: false,
          });
        } catch {
          // Expected: the fake LLM throws once real generation work starts.
        }
      },
      undefined,
      undefined,
      "German"
    );

    expect(started).not.toContain("translate_diagnosis");
    // Assert on the translation store itself, not just call counts on a
    // mock — this is the store the old `language !== "English"` predicate
    // used to pollute with `German: { "Influenza": "Influenza" }`.
    expect(saveTranslations).not.toHaveBeenCalled();
    expect(diagnosisCatalog.toEnglish("Influenza", "German")).toBeUndefined();
  });
});

describe("variant keys", () => {
  it("names activated flags, sorted and `+`-joined, `none` when empty", () => {
    expect(graphVariantKey(flags(false, false))).toBe("none");
    expect(graphVariantKey(flags(false, true))).toBe("procedure-preselection");
    expect(graphVariantKey(flags(true, false))).toBe("translation-sandwich");
    expect(graphVariantKey(flags(true, true))).toBe(
      "procedure-preselection+translation-sandwich"
    );
  });

  it("collapses to two topologies, since preselection is not a shape", () => {
    expect(ALL_GRAPH_FLAGS).toHaveLength(4);
    expect(new Set(ALL_GRAPH_FLAGS.map(graphTopologyKey))).toEqual(
      new Set(["none", "translation-sandwich"])
    );
  });
});

describe("buildCaseGraph", () => {
  const config = ConfigSchema.parse({
    LLM_PROVIDER: "ollama",
    LLM_MODEL: "llama3.1",
  });

  it("compiles all four variants at boot and returns a distinct one per combination", () => {
    const deps = buildDeps();
    const { getCaseGraph } = buildCaseGraph(
      deps.runtime,
      new EventBus(),
      config,
      deps.repos,
      deps.medicalBasisRegistry
    );

    const graphs = ALL_GRAPH_FLAGS.map((f) => getCaseGraph(f));
    expect(new Set(graphs).size).toBe(4);
  });

  it("returns the same instance for the same flags — the map is built once", () => {
    const deps = buildDeps();
    const { getCaseGraph } = buildCaseGraph(
      deps.runtime,
      new EventBus(),
      config,
      deps.repos,
      deps.medicalBasisRegistry
    );

    expect(getCaseGraph(flags(true, false))).toBe(
      getCaseGraph(flags(true, false))
    );
  });

  it("binds generateCase to the variant the deployer's config selects", async () => {
    const deps = buildDeps();
    const { caseGraph, getCaseGraph } = buildCaseGraph(
      deps.runtime,
      new EventBus(),
      ConfigSchema.parse({
        LLM_PROVIDER: "ollama",
        LLM_MODEL: "llama3.1",
        TRANSLATION_SANDWICH: "false",
        PROCEDURE_PRESELECTION: "true",
      }),
      deps.repos,
      deps.medicalBasisRegistry
    );

    expect(caseGraph).toBe(getCaseGraph(flags(false, true)));
    for (const node of TRANSLATION_NODES) {
      expect((await nodeIds(caseGraph)).some((id) => id.startsWith(node))).toBe(
        false
      );
    }
  });
});
