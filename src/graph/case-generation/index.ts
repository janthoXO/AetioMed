import { END, START, StateGraph } from "@langchain/langgraph";
import { GlobalStateSchema, GraphInputSchema } from "./state.js";
import { draftGraph } from "./01-draft/index.js";
import { councilGraph } from "./02-council/index.js";
import { checkConsistency, consistencyGraph } from "./03-consistency/index.js";
import type { Case } from "@/domain-models/Case.js";
import type { GenerationFlags } from "@/domain-models/GenerationFlags.js";

/**
 * Build and compile the Council-Consistency-Refinement graph
 */
export function buildCaseGeneratorGraph() {
  // Create the state graph with our annotation schema
  const graph = new StateGraph(GlobalStateSchema, {
    input: GraphInputSchema,
  });

  graph.addNode("draft_phase", draftGraph);
  graph.addEdge(START, "draft_phase");

  graph.addNode("council_phase", councilGraph);
  graph.addEdge("draft_phase", "council_phase");

  graph.addNode("consistency_reset", () => {
    // Reset inconsistencies for new consistency check
    return {
      inconsistencies: [],
    };
  });
  graph.addNode("consistency_phase", consistencyGraph);
  graph.addEdge("council_phase", "consistency_reset");
  graph.addEdge("consistency_reset", "consistency_phase");

  graph.addNode("draft_reset", () => {
    // Reset drafts for new generation cycle
    return {
      drafts: [],
    };
  });
  // Conditionally route back to start if inconsistencies found
  graph.addConditionalEdges("consistency_phase", checkConsistency, {
    refine: "draft_reset",
    end: END,
  });
  graph.addEdge("draft_reset", "draft_phase");

  const compiledGraph = graph.compile();

  console.log("[GraphBuilder] Case generation graph compiled");

  return compiledGraph;
}

/**
 * Execute the case generator graph
 */
export async function generateCase(
  diagnosis: string,
  context: string,
  generationFlags: GenerationFlags[]
): Promise<Case> {
  const graph = buildCaseGeneratorGraph();

  console.log(`[CaseGenerator] Starting case generation for: ${diagnosis}`);

  const result = await graph.invoke({
    diagnosis: diagnosis,
    context: context,
    generationFlags: generationFlags,
  });

  console.log("[CaseGenerator] Generation complete", result);

  if (!result.case) {
    throw new Error("Case generation failed: No case generated");
  }

  return result.case;
}
