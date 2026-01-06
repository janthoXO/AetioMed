import { START, StateGraph, END } from "@langchain/langgraph";
import {
  checkSkipCouncil,
  chooseVotedDraft,
  fanInCouncil,
  fanOutCouncil,
  voteDraft,
} from "./nodes.js";
import { type CouncilState, CouncilStateSchema } from "./state.js";

function passthrough(state: CouncilState) {
  return state;
}

export const councilGraph = new StateGraph(CouncilStateSchema)
  .addNode("council_start", passthrough)
  .addEdge(START, "council_start")
  .addNode("draft_vote", voteDraft)
  .addConditionalEdges("council_start", (state) => {
    if (checkSkipCouncil(state)) {
      return "draft_selection";
    }
    return fanOutCouncil(state);
  })
  .addNode("council_fan_in", fanInCouncil)
  .addEdge("draft_vote", "council_fan_in")
  .addNode("draft_selection", chooseVotedDraft)
  .addEdge("council_fan_in", "draft_selection")
  .addEdge("draft_selection", END)
  .compile();

export { checkSkipCouncil };
