import { Send } from "@langchain/langgraph";
import { type DraftState } from "./state.js";
import { generateCaseOneShot } from "@/services/cases.service.js";

/**
 * FAN-OUT
 *
 * Reads state.draftCount and returns an array of Send objects
 * to spawn N parallel draft_generation nodes.
 */
export function fanOutDrafts(state: DraftState): Send[] {
  const sends: Send[] = [];

  for (let i = 0; i < state.draftCount; i++) {
    sends.push(new Send("draft_generation", { ...state, draftIndex: i }));
  }

  console.debug(
    `[Draft: FanOutDrafts] Spawned ${sends.length} parallel generators`
  );
  return sends;
}

type GenerateDraftOutput = Pick<DraftState, "drafts">;
/**
 * Generates a complete medical case draft for the given diagnosis.
 * This node runs in parallel with other instances via the Send API.
 */
export async function generateDraft(
  state: DraftState & { draftIndex: number }
): Promise<GenerateDraftOutput> {
  console.debug(
    `[Draft: GenerateDraft #${state.draftIndex}] Starting generation`
  );

  const generatedCase = await generateCaseOneShot(
    state.generationFlags,
    state.diagnosis,
    state.context,
    state.anamnesisCategories,
    state.case,
    state.inconsistencies
  );

  console.debug(
    `[Draft: GenerateDraft #${state.draftIndex}] Successfully generated case ${generatedCase}`
  );

  return {
    drafts: [
      {
        ...generatedCase,
        draftIndex: state.draftIndex,
      },
    ],
  };
}

/**
 * WAIT FOR DRAFTS NODE
 *
 * A synchronization node that waits for all parallel draft generations to complete.
 * LangGraph handles the implicit fan-in, but this node marks the transition
 * from generation phase to critique phase.
 */
export function fanInDrafts(state: DraftState): Partial<DraftState> {
  console.log(
    `[Draft: FanInDrafts] Received ${state.drafts.length} case drafts`
  );
  // Return empty update to avoid duplicating appended fields via reducer
  return {};
}
