import { Send } from "@langchain/langgraph";
import {
  decodeObject,
  descriptionPromptDraft,
  handleLangchainError,
} from "@/utils/llmHelper.js";
import {
  CaseJsonExampleString,
  CaseJsonFormatZod,
  CaseSchema,
  type Case,
} from "@/domain-models/Case.js";
import { type DraftState } from "./state.js";
import { getCreativeLLM } from "@/graph/llm.js";
import {
  symptomsTool,
  symptomsToolForICD,
} from "@/graph/tools/symptoms.tool.js";
import { invokeWithTools } from "@/graph/invokeWithTool.js";
import {
  HumanMessage,
  providerStrategy,
  toolCallLimitMiddleware,
  type CreateAgentParams,
} from "langchain";
import { retry } from "@/utils/retry.js";
import { CaseGenerationError } from "@/errors/AppError.js";

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

Return your response in JSON ${state.generationFlags.includes("anamnesis") ? "with the provided anamnesis categories" : ""}:
${CaseJsonExampleString(state.generationFlags)}
${
  state.case
    ? `\nPrevious case generated:\n${JSON.stringify(state.case)}
with inconsistencies:\n${JSON.stringify(Object.values(state.inconsistencies).flat())}
`
    : ``
}
Requirements:
- Be medically accurate and realistic
- Do NOT directly reveal the diagnosis
- Use standard medical terminology
- If you need symptom information, call the get_symptoms_for_icd tool ONCE, then immediately proceed to generate the case
- After receiving symptom information (or if you don't need it), generate the complete case immediately
- Return ONLY the JSON content, no additional text`;

  const userPrompt = [
    `Provided Diagnosis for patient case: ${state.diagnosis} ${state.icdCode ?? ""}`,
    state.context ? `Additional provided context: ${state.context}` : "",
    state.generationFlags.includes("anamnesis")
      ? `Provided anamnesis categories: ${state.anamnesisCategories.join(", ")}`
      : "",
  ]
    .filter((s) => s.length > 0)
    .join("\n");

  console.debug(
    `[Draft: GenerateDraft #${state.draftIndex}] Prompt:\n${systemPrompt}\n${userPrompt}`
  );

  // Initialize cases to empty in case of failure
  try {
    const agentConfig: CreateAgentParams = {
      model: getCreativeLLM(),
      tools: [state.icdCode ? symptomsToolForICD(state.icdCode) : symptomsTool],
      systemPrompt: systemPrompt,
      middleware: [toolCallLimitMiddleware({ runLimit: 2 })],
      responseFormat: providerStrategy(
        CaseJsonFormatZod(state.generationFlags)
      ),
    };

    const parsedCase: Case = await retry(
      async () => {
        const text = await invokeWithTools(agentConfig, [
          new HumanMessage(userPrompt),
        ]).catch((error) => {
          handleLangchainError(error);
        });
        console.debug(
          `[Draft: GenerateDraft #${state.draftIndex}] LLM raw Response:\n${text}`
        );

        return await decodeObject(text)
          .then((object) => CaseSchema.parse(object))
          .catch(() => {
            throw new CaseGenerationError(
              `Failed to parse LLM response in JSON format`
            );
          });
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
