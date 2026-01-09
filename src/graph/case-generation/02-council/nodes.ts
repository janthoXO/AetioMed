import { Send } from "@langchain/langgraph";
import { getDeterministicLLM } from "@/graph/llm.js";
import { type CouncilState } from "./state.js";
import { encodeObject } from "@/utils/llmHelper.js";

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

  const prompt = `You are a senior medical educator picking the best case draft among several options.

The diagnosis to create a case for was: ${state.diagnosis}
${state.context ? `\nWith the additional given context: ${state.context}` : ""}

Here are the draft cases:
${encodeObject(state.drafts)}

Your task:
Select the BEST case. Ensure everything is appropriate, complete and consistent forming a coherent case

Return a singular number (the draftIndex of the best case) as response, nothing more.`;
  console.debug(`[Council: VoteDraft] Prompt:\n${prompt}`);

  try {
    const response = await getDeterministicLLM().invoke(prompt);
    const draftIndex = parseInt(response.content.toString());
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

  const bestDraft = state.drafts.find((d) => d.draftIndex === bestDraftIndex);
  if (!bestDraft) {
    console.warn("[Council: ChooseVotedDraft] Best draft not found!");
    return { case: state.drafts[0]! };
  }

  return { case: bestDraft };
}
