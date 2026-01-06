import { getDeterministicLLM } from "../llm.js";
import {
  InconsistencyJsonFormatZod,
  type Inconsistency,
} from "@/domain-models/Inconsistency.js";
import {
  decodeObject,
  encodeObject,
  formatPromptInconsistencies,
} from "@/utils/llmHelper.js";
import { config } from "@/utils/config.js";
import { type ConsistencyState } from "./state.js";

type GenerateInconsistenciesOutput = Pick<ConsistencyState, "inconsistencies">;
/**
 * Generates inconsistencies for the given case draft.
 */
export async function generateInconsistencies(
  state: ConsistencyState
): Promise<GenerateInconsistenciesOutput> {
  console.debug(
    "[Consistency: GenerateInconsistencies] Generating inconsistencies for case"
  );

  const prompt = `You are a medical quality assurance expert validating a patient case for educational use.

Target Diagnosis: ${state.diagnosis}

Case to validate:
${encodeObject(state.case)}

Check for these types of inconsistencies:
1. Is the diagnosis not directly revealed in the case?
2. Are all entries internally consistent and support each other?

${formatPromptInconsistencies()}

Requirements:
- Be thorough but fair
- Only flag genuine medical/logical inconsistencies
- Don't be overly pedantic
- Return ONLY the format content`;
  console.debug(`[Consistency: GenerateInconsistencies] Prompt:\n${prompt}`);

  try {
    const response = await getDeterministicLLM(
      config.LLM_FORMAT === "JSON" ? InconsistencyJsonFormatZod() : undefined
    ).invoke(prompt);
    const text = response.content.toString();
    const inconsistencies = (
      decodeObject(text) as { inconsistencies: Inconsistency[] }
    ).inconsistencies;
    console.debug(
      "[Consistency: GenerateInconsistencies] Parsed Inconsistencies:",
      inconsistencies
    );

    return {
      inconsistencies: inconsistencies.sort((a, b) =>
        a.field > b.field ? 1 : -1
      ),
    };
  } catch (error) {
    console.error("[Consistency: GenerateInconsistencies] Error:", error);
    throw error;
  }
}

type DecreaseConsistencyIterationOutput = Pick<
  ConsistencyState,
  "inconsistencyIterationsRemaining"
>;
/**
 * Decreases the remaining inconsistency iterations by one.
 */
export function decreaseConsistencyIteration(
  state: ConsistencyState
): DecreaseConsistencyIterationOutput {
  console.debug(
    `[Consistency: DecreaseConsistencyIteration] Remaining iterations after decrement: ${state.inconsistencyIterationsRemaining - 1}`
  );

  return {
    inconsistencyIterationsRemaining:
      state.inconsistencyIterationsRemaining - 1,
  };
}

export function checkConsistency(state: ConsistencyState): "refine" | "end" {
  console.debug(
    `[Consistency: CheckConsistency] Inconsistencies found: ${state.inconsistencies.length}, Remaining iterations: ${state.inconsistencyIterationsRemaining}`
  );

  return Object.keys(state.inconsistencies).length === 0 ||
    state.inconsistencyIterationsRemaining === 0
    ? "end"
    : "refine";
}
