import * as fs from "node:fs/promises";
import type { CompiledGraph } from "@langchain/langgraph";
import { buildTranslationGraph } from "./translation/index.js";
import { buildCaseGraph } from "./case/index.js";
import { run } from "@mermaid-js/mermaid-cli";

export async function exportGraphPng(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graph: CompiledGraph<any>,
  exportName: string
) {
  try {
    const mermaidDef = await graph
      .getGraphAsync({ xray: true })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((g: any) => g.drawMermaid());
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
  exportGraphPng(buildTranslationGraph(), "translation-graph"),
]);
