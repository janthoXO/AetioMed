// Issue 15 §4 — the actually compiled topology of the variant this
// deployment serves, plus each node's English label key. Served as
// `GET /api/graph` on REST and `meta.graph` on NATS (#144), so it lives in
// core rather than in either transport. It follows the labels' always-on
// gate (#140): a client that receives labels but cannot fetch the topology
// to hang them on has half a feature.
import type { CompiledCaseGraphs } from "./02graphs/caseGraph.js";
import { getNodeLabels } from "./utils/nodeWrapper.js";

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
 * graphs. Reuses exactly `getGraphAsync({ xray: true })` — the same call
 * `02graphs/exportGraphs.ts` uses to draw mermaid diagrams — so the two
 * must not drift (issue 15 §4).
 *
 * Since #159 the pipeline is two top-level graphs (plan, then case). Their
 * mount names never collide (`translation_to_english_phase`/
 * `planning_phase` vs `generation_phase`/`translation_from_english_phase`),
 * so the response is their union, in execution order, with the same
 * `{ nodes, edges }` shape as before. There is no edge between the two:
 * the job service, not a graph, runs one after the other.
 */
export async function buildGraphStructure(
  graphs: Pick<CompiledCaseGraphs, "plan" | "case"> &
    Partial<Pick<CompiledCaseGraphs, "outlineOut" | "reviewIn">>
): Promise<GraphStructure> {
  const labels = getNodeLabels();
  const nodes: StructureNode[] = [];
  const edges: StructureEdge[] = [];

  // The middle translation graphs (sandwich on only) sit between the two,
  // in the order plan mode runs them.
  const ordered = [
    graphs.plan,
    graphs.outlineOut,
    graphs.reviewIn,
    graphs.case,
  ].filter((g) => g !== undefined);

  for (const compiled of ordered) {
    const graph = await compiled.getGraphAsync({ xray: true });
    for (const id of Object.keys(graph.nodes)) {
      if (isSynthetic(id)) continue;
      nodes.push(
        labels[id] !== undefined ? { id, labelKey: labels[id] } : { id }
      );
    }
    for (const e of graph.edges) {
      if (isSynthetic(e.source) || isSynthetic(e.target)) continue;
      edges.push({ source: e.source, target: e.target });
    }
  }

  return { nodes, edges };
}
