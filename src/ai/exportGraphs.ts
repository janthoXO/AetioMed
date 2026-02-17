import * as fs from "node:fs/promises";
import type { CompiledGraph } from "@langchain/langgraph";
import { buildCaseDraftCouncilGraph } from "./case-draft-council-graph/index.js";
import { buildCasePersonaGraph } from "./case-persona-graph/index.js";

export async function exportGraphPng(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graph: CompiledGraph<any>,
  exportName: string
) {
  return graph
    .getGraphAsync({
      xray: true,
    })
    .then((graph) => graph.drawMermaidPng())
    .then((image) => image.arrayBuffer())
    .then((buffer) =>
      fs.writeFile(`docs/${exportName}.png`, new Uint8Array(buffer))
    )
    .catch((error) => console.error(error));
}

await Promise.all([
  exportGraphPng(buildCaseDraftCouncilGraph(), "case-draft-council-graph"),
  exportGraphPng(buildCasePersonaGraph(), "case-persona-graph"),
]);
