import { START, StateGraph, END } from "@langchain/langgraph";
import { generateInconsistencies } from "./nodes.js";
import { ConsistencyStateSchema } from "./state.js";

export const consistencyGraph = new StateGraph(ConsistencyStateSchema)
  .addNode("consistency_generation", generateInconsistencies)
  .addNode("consistency_reset", () => {
    // Reset inconsistencies for new consistency check
    return {
      inconsistencies: [],
    };
  })
  .addEdge(START, "consistency_reset")
  .addEdge("consistency_reset", "consistency_generation")
  .addEdge("consistency_generation", END)
  .compile();
