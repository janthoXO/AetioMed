import { START, StateGraph, END } from "@langchain/langgraph";
import { fanInDrafts, fanOutDrafts, generateDraft } from "./nodes.js";
import { DraftStateSchema } from "./state.js";

export const draftGraph = new StateGraph(DraftStateSchema)
  .addNode("draft_generation", generateDraft)
  .addConditionalEdges(START, fanOutDrafts, ["draft_generation"])
  .addNode("draft_fan_in", fanInDrafts)
  .addEdge("draft_generation", "draft_fan_in")
  .addEdge("draft_fan_in", END)
  .compile();
