import type { AgentStateType } from "./state.js";
import { getDeterministicLLM } from "./llm.js";
import { type Inconsistency } from "@/domain-models/Inconsistency.js";
import {
  decodeLLMResponse,
  encodeLLMRequest,
  formatPromptInconsistencies,
} from "@/utils/llmHelper.js";

export async function generateInconsistencies(
  state: AgentStateType
): Promise<{ inconsistencies: Record<string, Inconsistency[]> }> {
  console.debug("[CheckConsistency] Generating inconsistencies for case");

  const prompt = `You are a medical quality assurance expert validating a patient case for educational use.

Target Diagnosis: ${state.diagnosis}

Case to validate:
${encodeLLMRequest(state.cases[0]!)}

Check for these types of inconsistencies:
1. Is the diagnosis not directly revealed in the case?
2. Are all entries internally consistent and support each other?

${formatPromptInconsistencies()}

Requirements:
- Be thorough but fair
- Only flag genuine medical/logical inconsistencies
- Don't be overly pedantic
- Return ONLY the format content`;
  console.debug(`[CheckConsistency] Prompt:\n${prompt}`);

  try {
    const response = await getDeterministicLLM().invoke(prompt);
    const text = response.content.toString();
    console.debug(`[CheckConsistency] LLM Response:\n${text}`);
    const inconsistencies = (
      decodeLLMResponse(text) as { inconsistencies: Inconsistency[] }
    ).inconsistencies;
    console.debug(
      "[CheckConsistency] Parsed Inconsistencies:",
      inconsistencies
    );

    const inconsistenciesMap: Record<string, Inconsistency[]> = {};
    for (const inc of inconsistencies) {
      inconsistenciesMap[inc.field] = [
        ...(inconsistenciesMap[inc.field] || []),
        inc,
      ];
    }
    return { inconsistencies: inconsistenciesMap };
  } catch (error) {
    console.error("[CheckConsistency] Error:", error);
    throw error;
  }
}

export function decreaseConsistencyIteration(state: AgentStateType): {
  consistencyIteration: number;
} {
  console.debug(
    `[DecreaseConsistencyIteration] Remaining iterations: ${state.consistencyIteration}`
  );
  return { consistencyIteration: state.consistencyIteration };
}

export function checkConsistency(state: AgentStateType): "refine" | "end" {
  return Object.keys(state.inconsistencies).length === 0 ||
    state.consistencyIteration === 0
    ? "end"
    : "refine";
}
