import * as fs from "node:fs/promises";
import type { CompiledGraph } from "@langchain/langgraph";
import { run } from "@mermaid-js/mermaid-cli";
import { buildCaseGraph, graphTopologyKey } from "./caseGraph.js";
import type { Node, Graph } from "@langchain/core/runnables/graph";
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

function collapseSubgraphs(g: Graph, subgraphPrefixes: string[]) {
  const newNodes: Record<string, Node> = {};

  for (const [key, node] of Object.entries(g.nodes)) {
    const isInsideCollapsed = subgraphPrefixes.some((prefix) =>
      key.startsWith(`${prefix}:`)
    );
    if (!isInsideCollapsed) {
      newNodes[key] = node;
    }
  }

  for (const prefix of subgraphPrefixes) {
    newNodes[prefix] = {
      id: prefix,
      name: prefix,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: {} as any,
    };
  }

  g.nodes = newNodes;

  g.edges = g.edges
    .map((e) => {
      let source = e.source;
      let target = e.target;

      for (const prefix of subgraphPrefixes) {
        if (source.startsWith(`${prefix}:`)) source = prefix;
        if (target.startsWith(`${prefix}:`)) target = prefix;
      }
      return { ...e, source, target };
    })
    .filter((e) => e.source !== e.target);

  return g;
}

export async function exportGraphPng(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graph: CompiledGraph<any>,
  exportName: string,
  ...subgraphsToCollapse: string[]
) {
  try {
    const mermaidDef = await graph
      .getGraphAsync({ xray: true })
      .then((g) => collapseSubgraphs(g, subgraphsToCollapse))
      .then((g) => g.drawMermaid());
    const mmdPath = `docs/graphs/${exportName}.mmd` as `${string}.mmd`;
    const pngPath = `docs/graphs/${exportName}.svg` as `${string}.svg`;
    await fs.writeFile(mmdPath, mermaidDef, "utf-8");
    await run(mmdPath, pngPath);
  } catch (error) {
    console.error(error);
  }
}

export async function exportGraphOverviewPng(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graph: CompiledGraph<any>,
  exportName: string
) {
  try {
    const mermaidDef = await graph
      .getGraphAsync({ xray: 1 })
      .then((g) =>
        collapseSubgraphs(g, [
          "translation_to_english_phase",
          "translation_from_english_phase",
        ])
      )
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

const { getCaseGraph } = buildCaseGraph(
  minimalRuntime,
  new EventBus(),
  minimalConfig,
  {
    symptoms: minimalSymptomsRepo,
    anamnesis: minimalAnamnesisRepo,
    procedures: minimalProceduresRepo,
  }
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
  const graph = getCaseGraph(flags);
  const name = graphTopologyKey(flags);

  await exportGraphPng(graph, `case-graph.${name}`);
  await exportGraphOverviewPng(graph, `case-graph-overview.${name}`);
}
