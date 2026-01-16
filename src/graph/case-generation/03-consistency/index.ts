import { START, StateGraph, END } from "@langchain/langgraph";
import {
  checkRemainingIterations,
  decreaseConsistencyIteration,
  generateInconsistencies,
} from "./nodes.js";
import { ConsistencyStateSchema } from "./state.js";

export const consistencyGraph = new StateGraph(ConsistencyStateSchema)
  .addNode("consistency_iteration_decrease", decreaseConsistencyIteration)
  .addEdge(START, "consistency_iteration_decrease")
  .addNode("consistency_generation", generateInconsistencies)
  .addConditionalEdges("consistency_iteration_decrease", checkRemainingIterations, {
    run: "consistency_generation",
    skip: END,
  })
  .addEdge("consistency_generation", END)
  .compile();
