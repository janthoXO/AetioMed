import express from "express";
import type { CompiledCaseGraph } from "@/core/graph/02graphs/caseGraph.js";
import { buildGraphStructure } from "@/core/graph/structure.js";

/** `GET /api/graph` — the compiled topology labels are keyed against. */
export default function createGraphRouter(
  caseGraph: CompiledCaseGraph
): express.Router {
  const router = express.Router();

  router.get("/graph", (_req, res) => {
    buildGraphStructure(caseGraph)
      .then((structure) => res.json(structure))
      .catch((error) => {
        console.error("[rest] Failed to build graph structure", error);
        res.status(500).json({ error: "Failed to build graph structure" });
      });
  });

  return router;
}
