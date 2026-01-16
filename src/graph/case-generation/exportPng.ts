import * as fs from "node:fs/promises";
import { buildCaseGeneratorGraph } from "./index.js";

await buildCaseGeneratorGraph()
  .getGraphAsync({
    xray: true,
  })
  .then((graph) => graph.drawMermaidPng())
  .then((image) => image.arrayBuffer())
  .then((buffer) =>
    fs.writeFile("docs/case-generation-graph.png", new Uint8Array(buffer))
  )
  .catch((error) => console.error(error));
