// Compiled topology of the served variant plus each node's English label key.
// Served as `GET /api/graph` (REST) and `meta.graph` (NATS); always on.
import type { CompiledCaseGraphs } from "./02graphs/caseGraph.js";
import { getNodeLabels } from "./utils/nodeWrapper.js";

/** One node of the compiled graph, as reported to a client. */
export interface StructureNode {
  id: string;
  /**
   * English label key; undefined if no label recorded. Never localized:
   * structure stays language-independent and cacheable. Localized labels come
   * on the per-job `label` event.
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

/** LangGraph's synthetic `__start__`/`__end__` nodes never emit events; excluded. */
function isSynthetic(nodeId: string): boolean {
  const leaf = nodeId.split(":").pop()!;
  return leaf === "__start__" || leaf === "__end__";
}

/**
 * Structure of the compiled graphs via `getGraphAsync({ xray: true })`, same
 * call as `scripts/exportGraphs.ts`. Union of plan and case graphs (mount
 * names never collide), in execution order. No edge between them: the job
 * service runs one after the other.
 */
export async function buildGraphStructure(
  graphs: Pick<CompiledCaseGraphs, "plan" | "case"> &
    Partial<Pick<CompiledCaseGraphs, "outlineOut" | "reviewIn">>
): Promise<GraphStructure> {
  const labels = getNodeLabels();
  const nodes: StructureNode[] = [];
  const edges: StructureEdge[] = [];

  // Middle translation graphs (sandwich on only), in plan-mode run order.
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
