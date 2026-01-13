import { Send } from "@langchain/langgraph";
import { getDeterministicLLM } from "@/graph/llm.js";
import { type CouncilState } from "./state.js";
import { encodeObject } from "@/utils/llmHelper.js";
import {
  symptomsTool,
  symptomsToolForICD,
} from "@/graph/tools/symptoms.tool.js";
import { invokeWithTools, type AgentConfig } from "@/graph/invokeWithTool.js";
import { HumanMessage, toolCallLimitMiddleware } from "langchain";

/**
 * Check if generated drafts > 1 and councilSize > 1
 */
export function checkSkipCouncil(state: CouncilState): boolean {
  const skip = state.councilSize <= 1 || state.drafts.length <= 1;
  console.debug(
    `[Council: CheckSkipCouncil] Council size: ${state.councilSize}, Drafts: ${state.drafts.length}, Skip: ${skip}`
  );
  return skip;
}

/**
 * Iterates over all generated cases and spawns a parallel council agent
 * for each one using the Send API.
 */
export function fanOutCouncil(state: CouncilState): Send[] {
  const sends: Send[] = [];

  for (let i = 0; i < state.councilSize; i++) {
    sends.push(new Send("draft_vote", state));
  }

  console.debug(
    `[Council: FanOutCouncil] Spawning ${sends.length} parallel reviewers`
  );
  return sends;
}

type VoteDraftOutput = Pick<CouncilState, "votes">;
/**
 *
 * Votes for a specific draft among the council of generated cases.
 */
export async function voteDraft(state: CouncilState): Promise<VoteDraftOutput> {
  console.debug("[Council: VoteDraft] Voting for the best draft case");

  const systemPrompt = `You are a senior medical educator picking the best case draft among several options for a provided diagnosis with additional context.
Your task:
Select the BEST case. Ensure everything is appropriate, complete and consistent forming a coherent case
Return a singular number (the draftIndex of the best case) as response, nothing more.`;

  const userPrompt = `Diagnosis the cases were created for: ${state.diagnosis} ${state.icdCode ?? ""}
${state.context ? `\nAdditional context that was provided: ${state.context}` : ""}

Drafts to choose from:
${encodeObject(state.drafts)}`;

  console.debug(`[Council: VoteDraft] Prompt:\n${systemPrompt}\n${userPrompt}`);

  try {
    const agentConfig: AgentConfig = {
      model: getDeterministicLLM(),
      tools: [state.icdCode ? symptomsToolForICD(state.icdCode) : symptomsTool],
      systemPrompt: systemPrompt,
      middleware: [toolCallLimitMiddleware({ runLimit: 2 })],
    };

    const text = await invokeWithTools(agentConfig, [
      new HumanMessage(userPrompt),
    ]);
    const draftIndex = parseInt(text);
    console.debug(`[Council: VoteDraft] Voted for draft index: ${draftIndex}`);

    return { votes: { [draftIndex]: 1 } };
  } catch (error) {
    console.error("[Council: VoteDraft] Error:", error);
    throw error;
  }
}

/**
 * Fan in council
 */
export function fanInCouncil(state: CouncilState): Partial<CouncilState> {
  console.debug(
    "[Council: FanInCouncil] Merging votes from council members",
    state.votes
  );
  // Return empty update to avoid duplicating appended fields via reducer
  return {};
}

type ChooseVotedDraftOutput = Pick<CouncilState, "case">;
/**
 * return draft with most votes or first draft in case of tie
 */
export function chooseVotedDraft(state: CouncilState): ChooseVotedDraftOutput {
  console.debug("[Council: ChooseVotedDraft] votes:", state.votes);
  const bestDraftIndex = parseInt(
    Object.entries(state.votes).reduce(
      (acc, voteEntry) => {
        return voteEntry[1] > acc[1] ? voteEntry : acc;
      },
      ["0", 0]
    )[0]
  );

  console.debug(
    `[Council: ChooseVotedDraft] Selected best draft index: ${bestDraftIndex}`
  );
  console.debug("[Council: ChooseVotedDraft] All drafts:", state.drafts);

  const bestDraft = state.drafts.find((d) => d.draftIndex === bestDraftIndex);
  if (!bestDraft) {
    console.warn("[Council: ChooseVotedDraft] Best draft not found!");
    return { case: state.drafts[0]! };
  }

  return { case: bestDraft };
}
