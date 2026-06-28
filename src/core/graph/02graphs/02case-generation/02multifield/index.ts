import { END, START, StateGraph } from "@langchain/langgraph";
import { CaseGenerationStateSchema } from "../state.js";
import { fieldGenerationGraph } from "./generation/index.js";
import { inconsistencyGraph } from "./inconsistency/index.js";

// Thin wrapper that sequences field generation → inconsistency check using the
// shared CaseGenerationStateSchema so that it is type-compatible as a node in
// the outer caseGenerationGraph. Context propagates from the outer graph.
export const multiFieldGraph = new StateGraph(CaseGenerationStateSchema)
  .addNode("field_generation_phase", fieldGenerationGraph)
  .addNode("inconsistency_phase", inconsistencyGraph)

  .addEdge(START, "field_generation_phase")
  .addEdge("field_generation_phase", "inconsistency_phase")
  .addEdge("inconsistency_phase", END)
  .compile();
