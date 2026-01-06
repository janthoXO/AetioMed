import { START, StateGraph, END } from "@langchain/langgraph";
import { checkConsistency, decreaseConsistencyIteration, generateInconsistencies } from "./nodes.js";
import { ConsistencyStateSchema } from "./state.js";

export const consistencyGraph = new StateGraph(ConsistencyStateSchema)
  .addNode("consistency_generation", generateInconsistencies)
  .addEdge(START, "consistency_generation")
  .addNode("consistency_iteration_decrease", decreaseConsistencyIteration)
  .addEdge("consistency_generation", "consistency_iteration_decrease")
  .addEdge("consistency_iteration_decrease", END)
  .compile();

export { checkConsistency };
