import * as fs from "node:fs/promises";
import type { CompiledGraph } from "@langchain/langgraph";
import { run } from "@mermaid-js/mermaid-cli";
import { buildCaseGraph, graphTopologyKey } from "./caseGraph.js";
import { createMedicalBasisRegistry } from "../medicalBasis/registry.js";
import type { ModalityRegistries } from "../modality/registry.js";
import { createChiefComplaintProviders } from "./02case-generation/02presentation/generation/chiefComplaint/providers.js";
import { createAnamnesisProviders } from "./02case-generation/02presentation/generation/anamnesis/providers.js";
import { createProcedureResultProviders } from "./02case-generation/03procedure/providers.js";
import { EventBus } from "../../event-bus.js";
import type { GraphRuntime } from "../runtime.js";
import { InMemoryProcedureCatalog } from "../catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "../catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "../catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "../catalog/diagnosis/index.js";
import { createLogger } from "../utils/logger.js";
import type { Config } from "../config.js";
import type { SymptomsRepo } from "../symptoms/repo.js";
import type { AnamnesisRepo } from "../catalog/anamnesis/index.js";
import type { ProceduresRepo } from "../catalog/procedures/index.js";

export async function exportGraphPng(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graph: CompiledGraph<any>,
  exportName: string
) {
  try {
    const mermaidDef = await graph
      .getGraphAsync({ xray: true })
      .then((g) => g.drawMermaid());
    const mmdPath = `docs/graphs/${exportName}.mmd` as `${string}.mmd`;
    const pngPath = `docs/graphs/${exportName}.svg` as `${string}.svg`;
    await fs.writeFile(mmdPath, mermaidDef, "utf-8");
    await run(mmdPath, pngPath);
  } catch (error) {
    console.error(error);
  }
}

// Minimal runtime — this script only renders topology, it never calls the
// LLM or touches the filesystem-backed catalogues, so every port is a bare
// in-memory/no-op stand-in rather than the real app's composition root.
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

// Mirrors the composition root: one text provider per field — the planner
// always runs regardless of registry size (issue 21 §1), so there is no
// registry-size topology variance left for this script to show.
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

// Two topologies, not four. `PROCEDURE_PRESELECTION` swaps a
// `ProcedureStrategy` adapter and leaves the procedure graph at three nodes
// either way (issue 07), so the two preselection variants of each topology
// would render byte-identically. `graphTopologyKey` is the authority on this
// and `caseGraph.test.ts` asserts the premise still holds — if that test ever
// fails, this loop is what needs to grow back to four.
for (const translationSandwich of [false, true]) {
  const flags = { translationSandwich, procedurePreselection: false };
  const graphs = getCaseGraphs(flags);
  const name = graphTopologyKey(flags);

  // Two graphs per topology since #159: the plan graph ends with an outline,
  // the case graph starts from one.
  await exportGraphPng(graphs.plan, `plan-graph.${name}`);
  await exportGraphPng(graphs.case, `case-graph.${name}`);
}
