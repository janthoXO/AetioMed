// Assembly is pure wiring: minimal runtime and no-op repos, no LLM/filesystem/SQLite; same stand-ins as `exportGraphs.ts`.
import { describe, expect, it, vi } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  ALL_GRAPH_FLAGS,
  assembleCaseGraphs,
  buildCaseGraph,
  type CompiledCaseGraphs,
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
import z from "zod";
import type { ModalityProvider } from "@/core/graph/modality/ports.js";
import type { ModalityRegistries } from "@/core/graph/modality/registry.js";
import { buildFieldGenerationGraph } from "./02case-generation/02presentation/generation/index.js";
import {
  buildCaseGenerationGraph,
  buildPlanningPhaseGraph,
} from "./02case-generation/index.js";
import { buildPlanGraph } from "./02case-generation/01plan/index.js";
import { buildCaseTranslationToEnglishGraph } from "./01case-translation-to-english/index.js";
import { createProcedureStrategy } from "./02case-generation/03procedure/strategy/index.js";
import { taggedOutlineFixture } from "@/core/graph/outline/fixtures.js";

const TRANSLATION_NODES = [
  "translation_to_english_phase",
  "translation_from_english_phase",
];

/** The one production-shaped provider: batch-in, batch-out, `{instruction}` input. */
function fakeTextProvider(): ModalityProvider<unknown> {
  return {
    id: "text",
    mime: "text/plain",
    description: "test text provider",
    inputSchema: z.object({ instruction: z.string().min(1) }),
    render: async (batch) =>
      (batch as { instruction: string }[]).map((b) =>
        new TextEncoder().encode(b.instruction)
      ),
  };
}

function buildDeps(
  medicalBasisRegistry: MedicalBasisProvider[] = [
    { id: "fake-basis", fetch: async () => [] },
  ],
  modalityRegistries: ModalityRegistries = {
    chiefComplaint: [fakeTextProvider()],
    anamnesis: [fakeTextProvider()],
    procedureResult: [fakeTextProvider()],
  }
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
    modalityRegistries,
    traceNode: createTraceNode(bus),
  };
}

/** Every node id across both top-level graphs. */
async function allNodeIds(graphs: CompiledCaseGraphs): Promise<string[]> {
  return [
    ...(await nodeIds(graphs.plan)),
    ...(await nodeIds(graphs.case)),
  ].sort();
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

// Phase-level graphs with no dedicated test file. Subgraphs assert their own `outputChannels` in their own tests.
describe("phase-level graphs — output surface", () => {
  it("presentation_phase (buildFieldGenerationGraph) writes back only `case` — the outline is input", async () => {
    const deps = buildDeps();
    const graph = buildFieldGenerationGraph(
      deps.runtime,
      deps.modalityRegistries,
      deps.traceNode
    );
    expect([...graph.outputChannels].sort()).toEqual(["case"]);
  });

  it("generation_phase (buildCaseGenerationGraph) writes back only `case`", async () => {
    const deps = buildDeps();
    const strategy = createProcedureStrategy(deps.runtime, false);
    const graph = buildCaseGenerationGraph(
      deps.runtime,
      strategy,
      deps.modalityRegistries,
      deps.traceNode
    );
    expect([...graph.outputChannels].sort()).toEqual(["case"]);
  });

  it("planning_phase (buildPlanningPhaseGraph) writes back the outline, the verdict and the basis — never `case`", async () => {
    const deps = buildDeps();
    const graph = buildPlanningPhaseGraph(
      deps.runtime,
      deps.medicalBasisRegistry,
      deps.traceNode
    );
    expect([...graph.outputChannels].sort()).toEqual([
      "basisFragments",
      "outlineAccepted",
      "outlineSegments",
    ]);
  });

  it("translation_to_english_phase (buildCaseTranslationToEnglishGraph) writes back `diagnosis` and `userInstructions`, not `case`", async () => {
    const deps = buildDeps();
    const graph = buildCaseTranslationToEnglishGraph(
      deps.runtime,
      deps.traceNode
    );
    expect([...graph.outputChannels].sort()).toEqual([
      "diagnosis",
      "userInstructions",
    ]);
  });
});

describe("plan graph — outline and judge loop", () => {
  function scriptedRuntime(generator: string[], judge: string[]): GraphRuntime {
    const bus = new EventBus();
    return {
      llm: {
        for(opts) {
          const queue = opts.role === "judge" ? judge : generator;
          const response = queue.shift();
          if (response === undefined) {
            throw new Error(
              `Unexpected LLM call for role "${opts.role}" — not scripted.`
            );
          }
          return new FakeListChatModel({ responses: [response] });
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
  }

  const input = {
    diagnosis: { name: "Influenza" },
    difficulty: "medium" as const,
    basisFragments: [],
  };

  it("ends with the accepted outline as segments", async () => {
    const runtime = scriptedRuntime(
      [taggedOutlineFixture()],
      [JSON.stringify({ accepted: true, reasons: [] })]
    );
    const result = await buildPlanGraph(
      runtime,
      createTraceNode(new EventBus())
    ).invoke(input);

    expect(result.outlineAccepted).toBe(true);
    expect(result.outlineSegments.filter((s) => s.fixed)).toHaveLength(5);
  });

  it("ends not accepted, with the last outline, once the judge loop hits its cap", async () => {
    const rejected = JSON.stringify({
      accepted: false,
      reasons: ["too obvious"],
      suggestion: "add a distractor",
    });
    const runtime = scriptedRuntime(
      [
        taggedOutlineFixture({ body: "first" }),
        taggedOutlineFixture({ body: "second" }),
        taggedOutlineFixture({ body: "third" }),
      ],
      [rejected, rejected]
    );
    const result = await buildPlanGraph(
      runtime,
      createTraceNode(new EventBus())
    ).invoke(input);

    expect(result.outlineAccepted).toBe(false);
    expect(result.outlineSegments[2]!.text).toBe("third");
  });
});

describe("assembleCaseGraphs", () => {
  it("is pure: the same (deps, flags) produce the same node set", async () => {
    const deps = buildDeps();
    const a = await allNodeIds(assembleCaseGraphs(deps, flags(true, false)));
    const b = await allNodeIds(assembleCaseGraphs(deps, flags(true, false)));

    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("omits the translation nodes entirely when the sandwich is off", async () => {
    const ids = await allNodeIds(
      assembleCaseGraphs(buildDeps(), flags(false, false))
    );

    for (const node of TRANSLATION_NODES) {
      expect(ids.some((id) => id.startsWith(node))).toBe(false);
    }
  });

  it("includes both translation nodes when the sandwich is on", async () => {
    const ids = await allNodeIds(
      assembleCaseGraphs(buildDeps(), flags(true, false))
    );

    for (const node of TRANSLATION_NODES) {
      expect(ids.some((id) => id.startsWith(node))).toBe(true);
    }
  });

  it("keeps the per-request `procedures` branch in every variant", async () => {
    // `generationFlags` is per-request: procedure phase never compiled away.
    for (const f of ALL_GRAPH_FLAGS) {
      const ids = await allNodeIds(assembleCaseGraphs(buildDeps(), f));
      expect(
        ids.some((id) => id.includes("procedure_phase")),
        `procedure_phase missing from variant "${graphVariantKey(f)}"`
      ).toBe(true);
    }
  });

  it("compiles no basis_resolve node at all when the medical-basis registry is empty", async () => {
    const ids = await allNodeIds(
      assembleCaseGraphs(buildDeps([]), flags(false, false))
    );
    expect(ids.some((id) => id.includes("basis_resolve"))).toBe(false);
  });

  it("compiles a basis_resolve node when the medical-basis registry is non-empty", async () => {
    const ids = await allNodeIds(
      assembleCaseGraphs(
        buildDeps([{ id: "fake-basis", fetch: async () => [] }]),
        flags(false, false)
      )
    );
    expect(ids.some((id) => id.includes("basis_resolve"))).toBe(true);
  });

  it("rejects an empty chief-complaint modality registry at assembly time", () => {
    expect(() =>
      assembleCaseGraphs(
        buildDeps(undefined, {
          chiefComplaint: [],
          anamnesis: [fakeTextProvider()],
          procedureResult: [],
        }),
        flags(false, false)
      )
    ).toThrow(/modality registry is empty/i);
  });

  it("rejects an empty anamnesis modality registry at assembly time", () => {
    expect(() =>
      assembleCaseGraphs(
        buildDeps(undefined, {
          chiefComplaint: [fakeTextProvider()],
          anamnesis: [],
          procedureResult: [],
        }),
        flags(false, false)
      )
    ).toThrow(/modality registry is empty/i);
  });

  it("rejects an empty procedure-result modality registry at assembly time", () => {
    expect(() =>
      assembleCaseGraphs(
        buildDeps(undefined, {
          chiefComplaint: [fakeTextProvider()],
          anamnesis: [fakeTextProvider()],
          procedureResult: [],
        }),
        flags(false, false)
      )
    ).toThrow(/modality registry is empty/i);
  });

  it("compiles the outline translation graphs only with the sandwich", async () => {
    const off = assembleCaseGraphs(buildDeps(), flags(false, false));
    expect(off.outlineOut).toBeUndefined();
    expect(off.reviewIn).toBeUndefined();

    const on = assembleCaseGraphs(buildDeps(), flags(true, false));
    expect(await nodeIds(on.outlineOut!)).toContain("translate_outline_out");
    expect(await nodeIds(on.reviewIn!)).toContain("translate_review_in");
  });

  it("gives the two preselection variants of a topology identical shapes", async () => {
    // Premise of `exportGraphs.ts`'s two diagrams: PROCEDURE_PRESELECTION swaps strategy adapter, not topology.
    // On failure, export loop must grow to four.
    const deps = buildDeps();
    for (const sandwich of [false, true]) {
      const off = await allNodeIds(
        assembleCaseGraphs(deps, flags(sandwich, false))
      );
      const on = await allNodeIds(
        assembleCaseGraphs(deps, flags(sandwich, true))
      );
      expect(on).toEqual(off);
    }
  });
});

describe("language routing reads ALS, never graph state", () => {
  // Fake `llm.for()` throws (see `buildDeps`): full generation fails partway. Only nodes started before
  // the throw matter, via "Node Started" bus events.
  async function startedNodes(opts: {
    /** Bound on ALS, via `runWithContext` — the real read path. */
    alsLanguage?: string;
    /** Passed as an (unschemad) extra key on the invoke input — must be a no-op. */
    stateLanguage?: string;
    /** Provenance for translate-in edge. Defaults to `true` so German requests exercise translate-in. */
    callerSuppliedFreeText?: boolean;
  }): Promise<string[]> {
    const bus = new EventBus();
    const started: string[] = [];
    bus.on("Node Started", (e) => started.push(e.node));

    const deps = { ...buildDeps(), traceNode: createTraceNode(bus) };
    const graph = assembleCaseGraphs(deps, flags(true, false)).plan;

    await runWithContext(
      async () => {
        try {
          await graph.invoke({
            diagnosis: { name: "Influenza" },
            userInstructions: undefined,
            generationFlags: ["patient"],
            difficulty: "medium",
            callerSuppliedFreeText: opts.callerSuppliedFreeText ?? true,
            // Excess key: `PlanStateSchema` has no `language` field; input filtering must drop it silently,
            // so state cannot drive routing.
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
    expect(nodes).toContain("translation_to_english_phase:translate_diagnosis");
  });

  it("an English (default) request bound on ALS enters neither translation phase", async () => {
    const nodes = await startedNodes({ alsLanguage: undefined });
    expect(nodes).not.toContain(
      "translation_to_english_phase:translate_diagnosis"
    );
  });

  it("a `language` key on the invoke input has no effect — only ALS is read", async () => {
    // ALS says English (skip), state input says German — if routing ever
    // read state, this would translate; it must not.
    const nodes = await startedNodes({
      alsLanguage: undefined,
      stateLanguage: "German",
    });
    expect(nodes).not.toContain(
      "translation_to_english_phase:translate_diagnosis"
    );
  });
});

describe("translate-in trigger reads provenance, not just language", () => {
  it("a German request with callerSuppliedFreeText enters translate-to-English", async () => {
    // Exercises routing predicate directly, not via `startedNodes` default.
    const bus = new EventBus();
    const started: string[] = [];
    bus.on("Node Started", (e) => started.push(e.node));
    const deps = { ...buildDeps(), traceNode: createTraceNode(bus) };
    const graph = assembleCaseGraphs(deps, flags(true, false)).plan;

    await runWithContext(
      async () => {
        try {
          await graph.invoke({
            diagnosis: { name: "Influenza" },
            generationFlags: ["patient"],
            difficulty: "medium",
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

    expect(started).toContain(
      "translation_to_english_phase:translate_diagnosis"
    );
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
    const graph = assembleCaseGraphs(
      { ...deps, traceNode: createTraceNode(bus) },
      flags(true, false)
    ).plan;

    await runWithContext(
      async () => {
        try {
          await graph.invoke({
            // Resolved from the icd by `CaseGenerationService` before the
            // graph ever runs — already the catalogue's English name.
            diagnosis: { name: "Influenza", icd: "1E32" },
            generationFlags: ["patient"],
            difficulty: "medium",
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

    expect(started).not.toContain(
      "translation_to_english_phase:translate_diagnosis"
    );
    // Assert on translation store itself, not mock call counts: predicate must not pollute it with
    // identity entries like `German: { "Influenza": "Influenza" }`.
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
    const { getCaseGraphs } = buildCaseGraph(
      deps.runtime,
      new EventBus(),
      config,
      deps.repos,
      deps.medicalBasisRegistry,
      deps.modalityRegistries
    );

    const variants = ALL_GRAPH_FLAGS.map((f) => getCaseGraphs(f));
    expect(new Set(variants.map((v) => v.plan)).size).toBe(4);
    expect(new Set(variants.map((v) => v.case)).size).toBe(4);
  });

  it("returns the same instance for the same flags — the map is built once", () => {
    const deps = buildDeps();
    const { getCaseGraphs } = buildCaseGraph(
      deps.runtime,
      new EventBus(),
      config,
      deps.repos,
      deps.medicalBasisRegistry,
      deps.modalityRegistries
    );

    expect(getCaseGraphs(flags(true, false))).toBe(
      getCaseGraphs(flags(true, false))
    );
  });

  it("binds planCase/renderCase to the variant the deployer's config selects", async () => {
    const deps = buildDeps();
    const { graphs, getCaseGraphs } = buildCaseGraph(
      deps.runtime,
      new EventBus(),
      ConfigSchema.parse({
        LLM_PROVIDER: "ollama",
        LLM_MODEL: "llama3.1",
        TRANSLATION_SANDWICH: "false",
        PROCEDURE_PRESELECTION: "true",
      }),
      deps.repos,
      deps.medicalBasisRegistry,
      deps.modalityRegistries
    );

    expect(graphs).toBe(getCaseGraphs(flags(false, true)));
    const ids = await allNodeIds(graphs);
    for (const node of TRANSLATION_NODES) {
      expect(ids.some((id) => id.startsWith(node))).toBe(false);
    }
  });
});
