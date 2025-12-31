import { Send } from "@langchain/langgraph";
import type { AgentStateType, CaseWithDraftIndex } from "./state.js";
import { getCreativeLLM } from "./llm.js";
import {
  decodeLLMResponse,
  descriptionPromptDraft,
  encodeLLMRequest,
  formatPromptDraft,
} from "@/utils/llmHelper.js";
import { CaseSchema } from "@/domain-models/Case.js";
import { saveTransformToon } from "@/utils/toonHelper.js";
import { formatPromptDraftJsonZod } from "@/utils/jsonHelper.js";
import { config } from "@/utils/config.js";

/**
 * FAN-OUT
 *
 * Reads state.draftCount and returns an array of Send objects
 * to spawn N parallel draft_generation nodes.
 */
export function fanOutDrafts(state: AgentStateType): Send[] {
  const sends: Send[] = [];

  for (let i = 0; i < state.draftCount; i++) {
    sends.push(new Send("draft_generation", { ...state, draftIndex: i }));
  }

  console.debug(
    `[FanOutDrafts] Spawned ${sends.length} parallel draft generators`
  );
  return sends;
}

/**
 * Generates a complete medical case draft for the given diagnosis.
 * This node runs in parallel with other instances via the Send API.
 */
export async function generateDraft(
  state: AgentStateType & { draftIndex: number }
): Promise<{ cases: CaseWithDraftIndex[] }> {
  console.debug(`[GenerateDraft #${state.draftIndex}] Generating case draft`);

  const prompt = `You are a medical education expert creating realistic patient cases for medical students.

Generate a complete patient case for a patient with: ${state.diagnosis}
${state.context ? `\nAdditional context: ${state.context}` : ""}
The case should include:
${descriptionPromptDraft(state.generationFlags)}

${formatPromptDraft(state.generationFlags)}
${
  state.cases.length === 0
    ? ``
    : `\nPrevious case generated:\n${encodeLLMRequest(state.cases[0]!)} 
with inconsistencies:\n${encodeLLMRequest(Object.values(state.inconsistencies).flat())}
`
}
Requirements:
- Be medically accurate and realistic
- Do NOT directly reveal the diagnosis
- Use standard medical terminology
- Return ONLY the format content, no additional text`;

  console.debug(`[GenerateDraft #${state.draftIndex}] Prompt:\n${prompt}`);

  // Initialize cases to empty in case of failure
  try {
    const response = await getCreativeLLM(
      config.LLM_FORMAT === "JSON"
        ? formatPromptDraftJsonZod(state.generationFlags)
        : undefined
    ).invoke(prompt);
    const text = response.content.toString();
    console.debug(
      `[GenerateDraft #${state.draftIndex}] LLM raw Response:\n${text}`
    );

    console.debug(
      `[GenerateDraft #${state.draftIndex}] SaveTransform TOON\n`,
      saveTransformToon(text)
    );

    // Try to parse the TOON response
    const parsed = decodeLLMResponse(text);

    // Validate with Zod
    const caseResult = CaseSchema.safeParse(parsed);
    if (!caseResult.success) {
      throw new Error(`Case schema validation failed`);
    }

    console.debug(
      `[GenerateDraft #${state.draftIndex}] Successfully generated case ${caseResult.data}`
    );

    return { cases: [{ ...caseResult.data, draftIndex: state.draftIndex }] };
  } catch (error) {
    console.error(`[GenerateDraft #${state.draftIndex}] Error:`, error);
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
export function fanInDrafts(state: AgentStateType): AgentStateType {
  console.log(`[FanInDrafts] Received ${state.cases.length} case drafts`);
  return state;
}
