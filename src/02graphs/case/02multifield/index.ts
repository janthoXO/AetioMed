import { END, START, StateGraph } from "@langchain/langgraph";
import { GlobalStateSchema } from "../state.js";
import { generationGraph } from "./generation/index.js";
import { inconsistencyGraph } from "./inconsistency/index.js";

const MultiFieldGraphStateSchema = GlobalStateSchema;

export const multiFieldGraph = new StateGraph(MultiFieldGraphStateSchema)
  .addNode("generation_phase", generationGraph)
  .addNode("inconsistency_phase", inconsistencyGraph)

  .addEdge(START, "generation_phase")
  .addEdge("generation_phase", "inconsistency_phase")
  .addEdge("inconsistency_phase", END)
  .compile();
