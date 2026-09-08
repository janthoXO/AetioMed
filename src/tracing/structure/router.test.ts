// Issue 15 §4/§6 — `GET /api/graph` must reflect the *actually compiled*
// topology (flag-varied, since #120), and every id it reports must be one a
// real node can emit an event under, in both directions. `traceNode(...)`
// calls happen at graph-*construction* time (see `nodeWrapper.ts`), so a
// freshly built variant's `getNodeLabels()` already *is* that variant's
// complete traceable node-id set — no execution required to prove coverage.
import { describe, expect, it } from "vitest";
import {
  assembleCaseGraph,
  type AssemblyDeps,
} from "../../core/graph/02graphs/caseGraph.js";
import { EventBus } from "@/core/event-bus.js";
import {
  createTraceNode,
  getNodeLabels,
} from "@/core/graph/utils/nodeWrapper.js";
import { createLogger } from "@/core/graph/utils/logger.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import { InMemoryProcedureCatalog } from "@/core/graph/catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "@/core/graph/catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "@/core/graph/catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "@/core/graph/catalog/diagnosis/index.js";
import type { AnamnesisRepo } from "@/core/graph/catalog/anamnesis/index.js";
import type { ProceduresRepo } from "@/core/graph/catalog/procedures/index.js";
import type { MedicalBasisProvider } from "@/core/graph/medicalBasis/ports.js";
import { createTextModalityProvider } from "@/core/graph/modality/providers/text.js";
import type { ModalityProvider } from "@/core/graph/modality/ports.js";
import { buildGraphStructure } from "./router.js";

function buildDeps(
  medicalBasisRegistry: MedicalBasisProvider[] = [
    { id: "fake-basis", fetch: async () => [] },
  ],
  modalityRegistry: ModalityProvider[] = [createTextModalityProvider()]
): AssemblyDeps {
  const bus = new EventBus();
  const runtime: GraphRuntime = {
    llm: {
      for() {
        throw new Error("router.test: assembly must never call the LLM.");
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
    modalityRegistry,
    traceNode: createTraceNode(bus),
  };
}

describe("GET /api/graph structure (issue 15 §4)", () => {
  it("reflects a flag-varied topology: the sandwich-off graph has no translation nodes, the sandwich-on graph does", async () => {
    const off = await buildGraphStructure(
      assembleCaseGraph(buildDeps(), {
        translationSandwich: false,
        procedurePreselection: false,
      })
    );
    const on = await buildGraphStructure(
      assembleCaseGraph(buildDeps(), {
        translationSandwich: true,
        procedurePreselection: false,
      })
    );

    const offIds = off.nodes.map((n) => n.id);
    const onIds = on.nodes.map((n) => n.id);

    expect(offIds.some((id) => id.includes("translate_diagnosis"))).toBe(false);
    expect(onIds.some((id) => id.includes("translate_diagnosis"))).toBe(true);

    // The sandwich-off topology is a strict subset of the sandwich-on one —
    // same generation phase, minus the two translation phases.
    for (const id of offIds) {
      expect(onIds).toContain(id);
    }
    expect(onIds.length).toBeGreaterThan(offIds.length);
  });

  it("excludes LangGraph's own synthetic __start__/__end__ nodes", async () => {
    const structure = await buildGraphStructure(
      assembleCaseGraph(buildDeps(), {
        translationSandwich: true,
        procedurePreselection: false,
      })
    );

    for (const node of structure.nodes) {
      expect(node.id.endsWith("__start__")).toBe(false);
      expect(node.id.endsWith("__end__")).toBe(false);
    }
  });

  it("every node carries the English labelKey it was constructed with", async () => {
    const structure = await buildGraphStructure(
      assembleCaseGraph(buildDeps(), {
        translationSandwich: false,
        procedurePreselection: false,
      })
    );

    for (const node of structure.nodes) {
      expect(node.labelKey).toBeTruthy();
    }
  });

  it("both directions: every structure node id can emit an event, and every id a node can emit under appears in the structure", async () => {
    // `assembleCaseGraph` wraps every node via `traceNode` at *construction*
    // time (see `nodeWrapper.ts`) — so with this the only variant built in
    // this test, `getNodeLabels()` already is this topology's complete
    // traceable node-id set, without running anything.
    const compiled = assembleCaseGraph(buildDeps(), {
      translationSandwich: true,
      procedurePreselection: false,
    });
    const structure = await buildGraphStructure(compiled);

    const structureIds = new Set(structure.nodes.map((n) => n.id));
    const traceableIds = new Set(Object.keys(getNodeLabels()));

    // Direction 1: every structure node id was registered by `traceNode` —
    // i.e. is a node that can emit an event.
    for (const id of structureIds) {
      expect(traceableIds.has(id)).toBe(true);
    }
    // Direction 2: every id a node can emit under appears in the structure
    // — a one-directional check alone would pass even if half the graph
    // were unreachable from the structure endpoint.
    for (const id of traceableIds) {
      expect(structureIds.has(id)).toBe(true);
    }
  });
});
