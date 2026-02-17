import { Send } from "@langchain/langgraph";
import {
  getDeterministicLLM,
  decodeObject,
  handleLangchainError,
} from "@/ai/llm.js";
import { type CouncilState } from "./state.js";
import { symptomsTool, symptomsToolForICD } from "@/ai/tools/symptoms.tool.js";
import { invokeWithTools } from "@/ai/llm.js";
import {
  HumanMessage,
  toolCallLimitMiddleware,
  type CreateAgentParams,
} from "langchain";
import z from "zod";
import { GenerationError } from "@/errors/AppError.js";

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
    sends.push(new Send("generate_vote", state));
  }

  console.debug(
    `[Council: FanOutCouncil] Spawning ${sends.length} parallel reviewers`
  );
  return sends;
}

const VoteResponseSchema = z.object({
  draftIndex: z.number(),
});

type VoteDraftOutput = Pick<CouncilState, "votes">;
/**
 *
 * Votes for a specific draft among the council of generated cases.
 */
export async function generateVote(
  state: CouncilState
): Promise<VoteDraftOutput> {
  console.debug("[Council: GenerateVote] Voting for the best draft case");

  const systemPrompt = `You are a senior medical educator picking the best case draft among several options for a provided diagnosis with additional context.
Your task:
Select the BEST case. Ensure everything is appropriate, complete and consistent forming a coherent case
Return your response in JSON:
{draftIndex: number}`;

  const userPrompt = `Diagnosis the cases were created for: ${state.diagnosis.name} ${state.diagnosis.icd ?? ""}
${state.context ? `\nAdditional context that was provided: ${state.context}` : ""}

Drafts to choose from:
${JSON.stringify(state.drafts)}`;

  console.debug(
    `[Council: GenerateVote] Prompt:\n${systemPrompt}\n${userPrompt}`
  );

  const agentConfig: CreateAgentParams = {
    model: getDeterministicLLM(),
    tools: [
      state.diagnosis.icd
        ? symptomsToolForICD(state.diagnosis.icd)
        : symptomsTool,
    ],
    systemPrompt: systemPrompt,
    middleware: [toolCallLimitMiddleware({ runLimit: 2 })],
    responseFormat: VoteResponseSchema,
  };

  const text = await invokeWithTools(agentConfig, [
    new HumanMessage(userPrompt),
  ]).catch((error) => {
    handleLangchainError(error);
  });

  return await decodeObject(text)
    .then((object) => {
      const draftIndex = VoteResponseSchema.parse(object).draftIndex;
      console.debug(
        `[Council: GenerateVote] Voted for draft index: ${draftIndex}`
      );

      return { votes: { [draftIndex]: 1 } };
    })
    .catch((error) => {
      console.error("[Council: GenerateVote] Error:", error);
      throw new GenerationError(error);
    });
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
