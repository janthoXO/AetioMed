import * as fs from "node:fs/promises";
import type { CompiledGraph } from "@langchain/langgraph";
import { run } from "@mermaid-js/mermaid-cli";
import { buildCaseGraph } from "./caseGraph.js";
import type { Node, Graph } from "@langchain/core/runnables/graph";
import { EventBus } from "../../event-bus.js";
import type { GraphRuntime } from "../runtime.js";
import { InMemoryProcedureCatalog } from "../catalog/procedureCatalog.js";
import { InMemoryAnamnesisCatalog } from "../catalog/anamnesisCatalog.js";
import { InMemoryLabelCatalog } from "../catalog/labelCatalog.js";
import { InMemoryDiagnosisCatalog } from "../catalog/diagnosisCatalog.js";
import { createLogger } from "../utils/logger.js";
import type { Config } from "../config.js";

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
    const mmdPath = `docs/${exportName}.mmd` as `${string}.mmd`;
    const pngPath = `docs/${exportName}.svg` as `${string}.svg`;
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
    const mmdPath = `docs/${exportName}.mmd` as `${string}.mmd`;
    const pngPath = `docs/${exportName}.svg` as `${string}.svg`;
    await fs.writeFile(mmdPath, mermaidDef, "utf-8");
    await run(mmdPath, pngPath);
  } catch (error) {
    console.error(error);
  }
}

// Minimal runtime — this script only renders topology, it never calls the
// LLM or touches the filesystem-backed catalogues, so every port is a bare
// in-memory/no-op stand-in rather than the real app's composition root.
const minimalConfig: Config = {
  llm: {
    provider: "ollama",
    model: "unused",
    temperature: 0.7,
    apiKey: undefined,
    url: undefined,
  },
  allowedLlms: undefined,
  LLM_SMALL: false,
};

const minimalRuntime: GraphRuntime = {
  llm: {
    chat() {
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

const { caseGraph } = buildCaseGraph(
  minimalRuntime,
  new EventBus(),
  minimalConfig
);

await Promise.all([
  exportGraphPng(caseGraph, "case-graph"),
  exportGraphOverviewPng(caseGraph, "case-graph-overview"),
]);
