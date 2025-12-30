import { END, START, StateGraph } from "@langchain/langgraph";
import { AgentState, GraphInput, type AgentStateType } from "./state.js";
import { fanInDrafts, fanOutDrafts, generateDraft } from "./01-draft.js";
import {
  checkSkipCouncil,
  chooseVotedDraft,
  fanInCouncil,
  fanOutCouncil,
  voteDraft,
} from "./02-council.js";
import {
  checkConsistency,
  decreaseConsistencyIteration,
  generateInconsistencies,
} from "./03-consistency.js";
import type { Case } from "@/domain-models/Case.js";

export function passthrough(state: AgentStateType): AgentStateType {
  return state;
}

/**
 * Build and compile the Council-Consistency-Refinement graph
 */
export function buildCaseGeneratorGraph() {
  // Create the state graph with our annotation schema
  const graph = new StateGraph(AgentState, {
    input: GraphInput,
  });

  // Phase one generate case drafts in parallel
  graph.addNode("init", passthrough);
  graph.addEdge(START, "init");

  graph.addNode("draft_generation", generateDraft);
  graph.addConditionalEdges("init", fanOutDrafts, ["draft_generation"]);
  graph.addNode("draft_fan_in", fanInDrafts);
  graph.addEdge("draft_generation", "draft_fan_in");

  graph.addNode("council_init", passthrough);
  graph.addConditionalEdges("draft_fan_in", checkSkipCouncil, {
    true: "consistency_generation",
    false: "council_init",
  });
  graph.addNode("draft_vote", voteDraft);
  graph.addConditionalEdges("council_init", fanOutCouncil, ["draft_vote"]);
  graph.addNode("council_fan_in", fanInCouncil);
  graph.addEdge("draft_vote", "council_fan_in");
  graph.addNode("draft_selection", chooseVotedDraft);
  graph.addEdge("council_fan_in", "draft_selection");

  graph.addNode("consistency_generation", generateInconsistencies);
  graph.addEdge("draft_selection", "consistency_generation");
  graph.addNode("consistency_iteration_decrease", decreaseConsistencyIteration);
  graph.addEdge("consistency_generation", "consistency_iteration_decrease");

  // Conditionally route back to start if inconsistencies found
  graph.addConditionalEdges(
    "consistency_iteration_decrease",
    checkConsistency,
    {
      refine: "init",
      end: END,
    }
  );
  const compiledGraph = graph.compile();

  console.log("[GraphBuilder] Council-Consistency-Refinement graph compiled");

  return compiledGraph;
}

/**
 * Execute the case generator graph
 */
export async function generateCase(
  diagnosis: string,
  generationFlags: number,
  context: string
): Promise<Case> {
  const graph = buildCaseGeneratorGraph();

  console.log(`[CaseGenerator] Starting case generation for: ${diagnosis}`);

  const result = await graph.invoke({
    diagnosis: diagnosis,
    context: context,
    generationFlags: generationFlags,
  });

  console.log("[CaseGenerator] Generation complete", result);

  if (result.cases.length === 0) {
    throw new Error("No case generated");
  }

  return result.cases[0]!;
}
