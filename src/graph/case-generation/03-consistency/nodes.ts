import { getDeterministicLLM } from "@/graph/llm.js";
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

  const systemPrompt = `You are a medical quality assurance expert validating a patient case for educational use with a provided diagnosis and additional context.

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

  const userPrompt = `Provided Diagnosis: ${state.diagnosis}
${state.context ? `\nAdditional provided context: ${state.context}` : ""}`;

  console.debug(
    `[Consistency: GenerateInconsistencies] Prompt:\n${systemPrompt}\n${userPrompt}`
  );

  try {
    const response = await getDeterministicLLM(
      config.LLM_FORMAT === "JSON" ? InconsistencyJsonFormatZod() : undefined
    ).invoke([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);
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
