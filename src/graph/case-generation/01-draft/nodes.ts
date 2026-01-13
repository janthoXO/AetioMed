import { Send } from "@langchain/langgraph";
import {
  decodeObject,
  descriptionPromptDraft,
  encodeObject,
  formatPromptDraft,
} from "@/utils/llmHelper.js";
import {
  CaseJsonFormatZod,
  CaseSchema,
  type Case,
} from "@/domain-models/Case.js";
import { config } from "@/utils/config.js";
import { type DraftState } from "./state.js";
import { getCreativeLLM } from "@/graph/llm.js";
import { symptomsToolForICD } from "@/graph/tools/symptoms.tool.js";
import { invokeWithTools, type AgentConfig } from "@/graph/invokeWithTool.js";
import { HumanMessage, toolCallLimitMiddleware } from "langchain";
import { retry } from "@/utils/retry.js";

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

  const systemPrompt = `You are a medical education expert creating realistic patient cases for medical students for a provided diagnosis with additional context.
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
- If you need symptom information, call the get_symptoms_for_icd tool ONCE, then immediately proceed to generate the case
- After receiving symptom information (or if you don't need it), generate the complete case immediately
- Return ONLY ${config.LLM_FORMAT} format content, no additional text`;

  const userPrompt = `Provided Diagnosis for patient case: ${state.diagnosis} ICD ${state.icdCode}
${state.context ? `\nAdditional provided context: ${state.context}` : ""}`;

  console.debug(
    `[Draft: GenerateDraft #${state.draftIndex}] Prompt:\n${systemPrompt}\n${userPrompt}`
  );

  // Initialize cases to empty in case of failure
  try {
    const agentConfig: AgentConfig = {
      model: getCreativeLLM(),
      tools: [symptomsToolForICD(state.icdCode)],
      systemPrompt: systemPrompt,
      middleware: [toolCallLimitMiddleware({ runLimit: 2 })],
    };
    if (config.LLM_FORMAT === "JSON") {
      agentConfig.responseFormat = CaseJsonFormatZod(state.generationFlags);
    }

    const parsedCase: Case = await retry(
      async () => {
        const text = await invokeWithTools(agentConfig, [
          new HumanMessage(userPrompt),
        ]);
        console.debug(
          `[Draft: GenerateDraft #${state.draftIndex}] LLM raw Response:\n${text}`
        );

        // Try to parse the TOON response
        const parsed = await decodeObject(text);

        // Validate with Zod
        const caseResult = CaseSchema.safeParse(parsed);
        if (!caseResult.success) {
          throw new Error(`Case schema validation failed`);
        }

        return caseResult.data;
      },
      2,
      0
    );

    console.debug(
      `[Draft: GenerateDraft #${state.draftIndex}] Successfully generated case ${parsedCase}`
    );

    return {
      drafts: [
        {
          ...parsedCase,
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
