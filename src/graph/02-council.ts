import { Send } from "@langchain/langgraph";
import type { AgentStateType } from "./state.js";
import { getDeterministicLLM } from "./llm.js";
import { encode } from "@toon-format/toon";
import type { Case } from "@/domain-models/Case.js";

/**
 * Check if generated drafts are more than one
 */
export function checkSkipCouncil(state: AgentStateType): boolean {
  const skip = state.councileSize <= 1 || state.cases.length <= 1;
  console.debug(
    `[CheckSkipCouncil] Councile size: ${state.councileSize}, Drafts: ${state.cases.length}, Skip: ${skip}`
  );
  return skip;
}

/**
 * Iterates over all generated cases and spawns a parallel council agent
 * for each one using the Send API.
 */
export function fanOutCouncil(state: AgentStateType): Send[] {
  const sends: Send[] = [];

  for (let i = 0; i < state.councileSize; i++) {
    sends.push(new Send("draft_vote", state));
  }

  console.debug(`[FanOutCouncil] Spawning ${sends.length} parallel reviewers`);
  return sends;
}

/**
 *
 * Votes for a specific draft among the council of generated cases.
 */
export async function voteDraft(
  state: AgentStateType
): Promise<{ votes: Record<string, number> }> {
  console.debug("[VoteDraft] Voting for the best draft case");

  const prompt = `You are a senior medical educator picking the best case draft among several options.

The diagnosis to create a case for was: ${state.diagnosis}

Here are the draft cases:
${encode(state.cases)}

Your task:
Select the BEST case. Ensure everything is appropriate, complete and consistent forming a coherent case

Return a singular number (the draftIndex of the best case) as response, nothing more.`;
  console.debug(`[VoteDraft] Prompt:\n${prompt}`);

  try {
    const response = await getDeterministicLLM().invoke(prompt);
    const draftIndex = parseInt(response.content.toString());
    console.debug(`[VoteDraft] Voted for draft index: ${draftIndex}`);

    return { votes: { [draftIndex]: 1 } };
  } catch (error) {
    console.error("[Synthesize] Error:", error);
    throw error;
  }
}

/**
 * Fan in council
 */
export function fanInCouncil(state: AgentStateType): AgentStateType {
  console.debug("[FanInCouncil] Merging votes from council members");

  return state;
}

/**
 * return draft with most votes
 */
export function chooseVotedDraft(state: AgentStateType): {
  votes: {
    replace: true;
    votes: Record<string, number>;
  };
  cases: {
    replace: boolean;
    cases: Case[];
  };
} {
  console.debug("[ChooseVotedDraft] votes:", state.votes);
  const bestDraftIndex = parseInt(
    Object.entries(state.votes).reduce(
      (acc, voteEntry) => {
        return voteEntry[1] > acc[1] ? voteEntry : acc;
      },
      ["0", 0]
    )[0]
  );

  console.debug(
    `[ChooseVotedDraft] Selected best draft index: ${bestDraftIndex}`
  );

  const bestDraft = state.cases.find((c) => c.draftIndex === bestDraftIndex);

  return {
    votes: { replace: true, votes: {} },
    cases: { replace: true, cases: bestDraft ? [bestDraft] : [] },
  };
}
