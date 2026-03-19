import * as fs from "node:fs/promises";
import type { CompiledGraph } from "@langchain/langgraph";
import { buildCasePersonaGraph } from "./case-persona-graph/index.js";
import { buildTranslationGraph } from "./translation-graph/index.js";

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
  exportGraphPng(buildCasePersonaGraph(), "case-persona-graph"),
  exportGraphPng(buildTranslationGraph(), "translation-graph"),
]);
