import { START, StateGraph, END } from "@langchain/langgraph";
import { fanInDrafts, fanOutDrafts, generateDraft } from "./nodes.js";
import { DraftStateSchema, type DraftState } from "./state.js";

function passthrough(state: DraftState) {
  return state;
}

export const draftGraph = new StateGraph(DraftStateSchema)
  .addNode("draft_start", passthrough)
  .addEdge(START, "draft_start")
  .addNode("draft_generation", generateDraft)
  .addConditionalEdges("draft_start", fanOutDrafts, ["draft_generation"])
  .addNode("draft_fan_in", fanInDrafts)
  .addEdge("draft_generation", "draft_fan_in")
  .addEdge("draft_fan_in", END)
  .compile();
