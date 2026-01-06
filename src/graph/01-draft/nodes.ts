import { Send } from "@langchain/langgraph";
import { getCreativeLLM } from "../llm.js";
import {
  decodeObject,
  descriptionPromptDraft,
  encodeObject,
  formatPromptDraft,
} from "@/utils/llmHelper.js";
import { CaseSchema } from "@/domain-models/Case.js";
import { formatPromptDraftJsonZod } from "@/utils/jsonHelper.js";
import { config } from "@/utils/config.js";
import { type DraftState } from "./state.js";

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

  const prompt = `You are a medical education expert creating realistic patient cases for medical students.

Generate a complete patient case for a patient with: ${state.diagnosis}
${state.context ? `\nAdditional context: ${state.context}` : ""}
The case should include:
${descriptionPromptDraft(state.generationFlags)}

${formatPromptDraft(state.generationFlags)}
${
  state.case
    ? `\nPrevious case generated:\n${encodeObject(state.case)}
with inconsistencies:\n${encodeObject(Object.values(state.inconsistencies).flat())}
`
    : ``
}
Requirements:
- Be medically accurate and realistic
- Do NOT directly reveal the diagnosis
- Use standard medical terminology
- Return ONLY the format content, no additional text`;

  console.debug(
    `[Draft: GenerateDraft #${state.draftIndex}] Prompt:\n${prompt}`
  );

  // Initialize cases to empty in case of failure
  try {
    const response = await getCreativeLLM(
      config.LLM_FORMAT === "JSON"
        ? formatPromptDraftJsonZod(state.generationFlags)
        : undefined
    ).invoke(prompt);
    const text = response.content.toString();
    console.debug(
      `[Draft: GenerateDraft #${state.draftIndex}] LLM raw Response:\n${text}`
    );

    // Try to parse the TOON response
    const parsed = decodeObject(text);

    // Validate with Zod
    const caseResult = CaseSchema.safeParse(parsed);
    if (!caseResult.success) {
      throw new Error(`Case schema validation failed`);
    }

    console.debug(
      `[Draft: GenerateDraft #${state.draftIndex}] Successfully generated case ${caseResult.data}`
    );

    return {
      drafts: [
        {
          ...caseResult.data,
          draftIndex: state.draftIndex,
        },
      ],
    };
  } catch (error) {
    console.error(`[Draft: GenerateDraft #${state.draftIndex}] Error:`, error);
    throw error;
  }
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
