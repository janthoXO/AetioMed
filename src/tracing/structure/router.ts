// Issue 15 §4 — `GET /api/graph`: the actually compiled topology of the
// variant this deployment serves, plus each node's English label key.
import express from "express";
import type { CompiledCaseGraph } from "@/core/graph/02graphs/caseGraph.js";
import { getNodeLabels } from "@/core/graph/utils/nodeWrapper.js";

/** One node of the compiled graph, as reported to a client. */
export interface StructureNode {
  id: string;
  /**
   * English label key, or `undefined` for a node that has one (every
   * `traceNode`-wrapped node does — see `nodeWrapper.ts`) but whose label
   * hasn't been recorded for some reason. Never localized here — issue 15
   * §4's settled reason: the structure is language-independent and
   * cacheable, whereas a localized response would need a `language`
   * parameter and a cache entry per language for data that never varies by
   * language. A client wanting localization already has it on the SSE
   * `label` event, per job.
   */
  labelKey?: string;
}

export interface StructureEdge {
  source: string;
  target: string;
}

export interface GraphStructure {
  nodes: StructureNode[];
  edges: StructureEdge[];
}

/**
 * LangGraph's own synthetic per-(sub)graph nodes. They never run a
 * `traceNode`-wrapped function and can never emit an event, so they are
 * excluded here — including them would fail the "every node in the
 * structure can emit an event" half of the issue 15 §6 bidirectional test,
 * and they carry no useful information for a client rendering the pipeline.
 */
function isSynthetic(nodeId: string): boolean {
  const leaf = nodeId.split(":").pop()!;
  return leaf === "__start__" || leaf === "__end__";
}

/**
 * Build the structure response from the deployment's actually-compiled
 * graph. Reuses exactly `getGraphAsync({ xray: true })` — the same call
 * `02graphs/exportGraphs.ts` uses to draw mermaid diagrams — so the two
 * must not drift (issue 15 §4).
 */
export async function buildGraphStructure(
  caseGraph: CompiledCaseGraph
): Promise<GraphStructure> {
  const graph = await caseGraph.getGraphAsync({ xray: true });
  const labels = getNodeLabels();

  const nodes = Object.keys(graph.nodes)
    .filter((id) => !isSynthetic(id))
    .map((id) =>
      labels[id] !== undefined ? { id, labelKey: labels[id] } : { id }
    );

  const edges = graph.edges
    .filter((e) => !isSynthetic(e.source) && !isSynthetic(e.target))
    .map((e) => ({ source: e.source, target: e.target }));

  return { nodes, edges };
}

export default function createStructureRouter(
  caseGraph: CompiledCaseGraph
): express.Router {
  const router = express.Router();

  router.use((_req, _res, next) => {
    /* #swagger.tags = ['Traces'] */
    next();
  });

  router.get("/graph", (_req, res) => {
    buildGraphStructure(caseGraph)
      .then((structure) => res.json(structure))
      .catch((error) => {
        console.error(
          "[tracing/structure] Failed to build graph structure",
          error
        );
        res.status(500).json({ error: "Failed to build graph structure" });
      });
  });

  return router;
}
