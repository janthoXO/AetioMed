// Assembly is pure wiring, so these tests need no LLM, no filesystem and no
// SQLite — just a minimal runtime and no-op repos, mirroring the stand-ins
// `exportGraphs.ts` already uses for the same reason.
import { describe, expect, it } from "vitest";
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
