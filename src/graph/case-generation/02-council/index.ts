import { START, StateGraph, END } from "@langchain/langgraph";
import {
  checkSkipCouncil,
  chooseVotedDraft,
  fanInCouncil,
  fanOutCouncil,
  generateVote,
} from "./nodes.js";
import { CouncilStateSchema } from "./state.js";

export const councilGraph = new StateGraph(CouncilStateSchema)
  .addNode("draft_selection", chooseVotedDraft)
  .addNode("generate_vote", generateVote)
  .addConditionalEdges(START, (state) => {
    if (checkSkipCouncil(state)) {
      return "draft_selection";
    }

    return fanOutCouncil(state);
  })
  .addNode("council_fan_in", fanInCouncil)
  .addEdge("generate_vote", "council_fan_in")
  .addEdge("council_fan_in", "draft_selection")
  .addEdge("draft_selection", END)
  .compile();

export { checkSkipCouncil };
