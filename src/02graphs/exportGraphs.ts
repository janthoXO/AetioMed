import * as fs from "node:fs/promises";
import type { CompiledGraph } from "@langchain/langgraph";
import { run } from "@mermaid-js/mermaid-cli";
import { buildCaseGraph } from "./caseGraph.js";
import type { Node, Graph } from "@langchain/core/runnables/graph";

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
      .then((g) => collapseSubgraphs(g, ["translation_phase"]))
      .then((g) => g.drawMermaid());
    const mmdPath = `docs/${exportName}.mmd` as `${string}.mmd`;
    const pngPath = `docs/${exportName}.svg` as `${string}.svg`;
    await fs.writeFile(mmdPath, mermaidDef, "utf-8");
    await run(mmdPath, pngPath);
  } catch (error) {
    console.error(error);
  }
}

await Promise.all([
  exportGraphPng(buildCaseGraph(), "case-graph"),
  exportGraphOverviewPng(buildCaseGraph(), "case-graph-overview"),
]);
