import { getDeterministicLLM } from "@/graph/llm.js";
import {
  InconsistencyArrayJsonFormatZod,
  type Inconsistency,
} from "@/domain-models/Inconsistency.js";
import {
  decodeObject,
  encodeObject,
  formatPromptInconsistencies,
} from "@/utils/llmHelper.js";
import { config } from "@/utils/config.js";
import { type ConsistencyState } from "./state.js";
import { symptomsToolForICD } from "@/graph/tools/symptoms.tool.js";
import { invokeWithTools, type AgentConfig } from "@/graph/invokeWithTool.js";
import { HumanMessage, toolCallLimitMiddleware } from "langchain";
import { retry } from "@/utils/retry.js";

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
- If you need symptom information, call the get_symptoms_for_icd tool ONCE, then immediately proceed to generate the inconsistencies
- Only flag genuine medical/logical inconsistencies
- Don't be overly pedantic
- Return ONLY ${config.LLM_FORMAT} format content`;

  const userPrompt = `Provided Diagnosis: ${state.diagnosis} ICD ${state.icdCode}
${state.context ? `\nAdditional provided context: ${state.context}` : ""}`;

  console.debug(
    `[Consistency: GenerateInconsistencies] Prompt:\n${systemPrompt}\n${userPrompt}`
  );

  try {
    const agentConfig: AgentConfig = {
      model: getDeterministicLLM(),
      tools: [symptomsToolForICD(state.icdCode)],
      systemPrompt: systemPrompt,
      middleware: [toolCallLimitMiddleware({ runLimit: 3 })],
    };
    if (config.LLM_FORMAT === "JSON") {
      agentConfig.responseFormat = InconsistencyArrayJsonFormatZod();
    }

    const parsedInconsistencies: Inconsistency[] = await retry(
      async () => {
        const text = await invokeWithTools(agentConfig, [
          new HumanMessage(userPrompt),
        ]);
        console.debug(
          "[Consistency: GenerateInconsistencies] LLM Response:",
          text
        );

        const parsed = await decodeObject(text);

        const inconsistencyResult =
          InconsistencyArrayJsonFormatZod().safeParse(parsed);
        if (!inconsistencyResult.success) {
          throw new Error(`Inconsistency schema validation failed`);
        }

        return inconsistencyResult.data.inconsistencies;
      },
      2,
      0
    );

    console.debug(
      "[Consistency: GenerateInconsistencies] Parsed Inconsistencies:",
      parsedInconsistencies
    );

    return {
      inconsistencies: parsedInconsistencies.sort((a, b) =>
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
