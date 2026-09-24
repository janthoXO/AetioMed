import * as fs from "node:fs/promises";
import {
  Annotation,
  END,
  START,
  StateGraph,
  type CompiledGraph,
} from "@langchain/langgraph";
import { run } from "@mermaid-js/mermaid-cli";
import {
  buildCaseGraph,
  graphTopologyKey,
} from "@/core/graph/02graphs/caseGraph.js";
import { createMedicalBasisRegistry } from "@/core/graph/medicalBasis/registry.js";
import type { ModalityRegistries } from "@/core/graph/modality/registry.js";
import { createChiefComplaintProviders } from "@/core/graph/02graphs/02case-generation/02presentation/generation/chiefComplaint/providers.js";
import { createAnamnesisProviders } from "@/core/graph/02graphs/02case-generation/02presentation/generation/anamnesis/providers.js";
import { createProcedureResultProviders } from "@/core/graph/02graphs/02case-generation/03procedure/providers.js";
import { EventBus } from "@/core/event-bus.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import { InMemoryProcedureCatalog } from "@/core/graph/catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "@/core/graph/catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "@/core/graph/catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "@/core/graph/catalog/diagnosis/index.js";
import { createLogger } from "@/core/graph/utils/logger.js";
import type { Config } from "@/core/graph/config.js";
import type { SymptomsRepo } from "@/core/graph/symptoms/repo.js";
import type { AnamnesisRepo } from "@/core/graph/catalog/anamnesis/index.js";
import type { ProceduresRepo } from "@/core/graph/catalog/procedures/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

async function exportGraphPng(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graph: CompiledGraph<any>,
  exportName: string
) {
  try {
    const drawable = await graph.getGraphAsync({ xray: true });
    // Drop the wrapper level: `drawMermaid` skips every subgraph below a prefix with no edges of
    // its own, which a wrapped graph with one child phase is (no-sandwich plan/case graphs).
    const strip = (id: string) => id.replace(/^(plan|case):/, "");
    drawable.nodes = Object.fromEntries(
      Object.values(drawable.nodes).map((node) => {
        node.id = strip(node.id);
        node.name = strip(node.name);
        return [node.id, node];
      })
    );
    for (const edge of drawable.edges) {
      edge.source = strip(edge.source);
      edge.target = strip(edge.target);
    }
    const mermaidDef = drawable.drawMermaid();
    const mmdPath = `docs/graphs/${exportName}.mmd` as `${string}.mmd`;
    const pngPath = `docs/graphs/${exportName}.svg` as `${string}.svg`;
    await fs.writeFile(mmdPath, mermaidDef, "utf-8");
    await run(mmdPath, pngPath);
  } catch (error) {
    console.error(error);
  }
}

// Minimal runtime: script only renders topology, so every port is a bare no-op stand-in.
const minimalLlmRole: {
  provider: "ollama";
  model: string;
  apiKey?: string | undefined;
  url?: string | undefined;
} = {
  provider: "ollama",
  model: "unused",
};

const minimalConfig: Config = {
  llm: minimalLlmRole,
  llmRoles: {
    generator: minimalLlmRole,
    judge: minimalLlmRole,
    translator: minimalLlmRole,
  },
  allowedLlms: undefined,
  PROCEDURE_PRESELECTION: false,
  TRANSLATION_SANDWICH: true,
  LANGUAGES: ["English", "German"],
  LANGUAGE_AUTO_DETECT: false,
  LANGUAGE_DETECT_LLM_FALLBACK: false,
  MAX_CONTENT_PART_BYTES: 5_000_000,
};

const minimalRuntime: GraphRuntime = {
  llm: {
    for() {
      throw new Error(
        "exportGraphs: the LLM is never called while exporting graph topology."
      );
    },
  },
  catalogs: {
    procedures: new InMemoryProcedureCatalog(),
    anamnesis: new InMemoryAnamnesisCatalog(),
    labels: new InMemoryLabelCatalog(),
    diagnosis: new InMemoryDiagnosisCatalog(),
  },
  log: createLogger(new EventBus()),
  clock: () => new Date(),
};

// No-op stand-ins: never called while exporting topology, so none of these
// touch the filesystem or the embedded database.
const minimalSymptomsRepo: SymptomsRepo = {
  SymptomsRelatedToDiagnosisIcd: () => [],
  getCachedSymptoms: () => undefined,
  saveCachedSymptoms: () => {},
};

const minimalAnamnesisRepo: AnamnesisRepo = {
  translationsFile: "",
  getAnamnesisCategoryTranslationFromEnglish: () => undefined,
  saveAnamnesisCategoryTranslations: () => {},
  getEffectiveCategoryList: () => undefined,
};

const minimalProceduresRepo: ProceduresRepo = {
  translationsFile: "",
  getProcedureNameTranslationFromEnglish: () => undefined,
  saveProcedureNameTranslation: () => {},
  getEffectiveProcedureList: () => undefined,
};

// Mirrors the composition root (`graph/index.ts`): the registry always has
// the one UMLS-symptom provider today, so the exported topology shows
// `basis_resolve` exactly as a real deployment's graph would.
const medicalBasisRegistry = createMedicalBasisRegistry({
  runtime: minimalRuntime,
  symptomsRepo: minimalSymptomsRepo,
});

// Mirrors composition root: one text provider per field. Planner always runs, so registry size never changes topology.
const modalityRegistries: ModalityRegistries = {
  chiefComplaint: createChiefComplaintProviders(minimalRuntime),
  anamnesis: createAnamnesisProviders(minimalRuntime),
  procedureResult: createProcedureResultProviders(minimalRuntime),
};

const { getCaseGraphs } = buildCaseGraph(
  minimalRuntime,
  new EventBus(),
  minimalConfig,
  {
    anamnesis: minimalAnamnesisRepo,
    procedures: minimalProceduresRepo,
  },
  medicalBasisRegistry,
  modalityRegistries
);

await fs.mkdir("docs/graphs", { recursive: true });

// Export-only wrapper: one diagram per mode, the job service's call sequence drawn as edges.
// `human_review` is the reviewer between the two calls; nothing runs there.
function wrap(steps: [string, AnyNode][]) {
  const g = new StateGraph(Annotation.Root({}));
  for (const [name, node] of steps) g.addNode(name, node);
  const names = [START, ...steps.map(([name]) => name), END];
  for (let i = 1; i < names.length; i++) g.addEdge(names[i - 1]!, names[i]!);
  return g.compile();
}

const humanReview: AnyNode = () => ({});

// Two topologies, not four: `PROCEDURE_PRESELECTION` swaps a `ProcedureStrategy` adapter, so preselection variants
// render identically. `graphTopologyKey` is authority; `caseGraph.test.ts` asserts it.
for (const translationSandwich of [false, true]) {
  const flags = { translationSandwich, procedurePreselection: false };
  const { plan, case: caseGraph, outlineOut, reviewIn } = getCaseGraphs(flags);
  const name = graphTopologyKey(flags);

  // Second call re-enters `plan` too (translate-in only, planning skipped); not drawn twice.
  const planMode: [string, AnyNode][] =
    outlineOut && reviewIn
      ? [
          ["plan", plan],
          ["outline_translation_out", outlineOut],
          ["human_review", humanReview],
          ["outline_translation_in", reviewIn],
          ["case", caseGraph],
        ]
      : [
          ["plan", plan],
          ["human_review", humanReview],
          ["case", caseGraph],
        ];
  await exportGraphPng(wrap(planMode), `plan-mode.${name}`);
  await exportGraphPng(
    wrap([
      ["plan", plan],
      ["case", caseGraph],
    ]),
    `normal-mode.${name}`
  );
}
