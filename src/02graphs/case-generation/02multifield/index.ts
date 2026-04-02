import { END, START, StateGraph } from "@langchain/langgraph";
import { CaseGenerationStateSchema } from "../state.js";
import { fieldGenerationGraph } from "./generation/index.js";
import { inconsistencyGraph } from "./inconsistency/index.js";

const MultiFieldGraphStateSchema = CaseGenerationStateSchema;

export const multiFieldGraph = new StateGraph(MultiFieldGraphStateSchema)
  .addNode("field_generation_phase", fieldGenerationGraph)
  .addNode("inconsistency_phase", inconsistencyGraph)

  .addEdge(START, "field_generation_phase")
  .addEdge("field_generation_phase", "inconsistency_phase")
  .addEdge("inconsistency_phase", END)
  .compile();
