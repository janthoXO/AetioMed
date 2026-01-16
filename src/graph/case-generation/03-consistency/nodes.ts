import { getDeterministicLLM } from "@/graph/llm.js";
import {
  InconsistencyArrayJsonFormatZod,
  type Inconsistency,
} from "@/domain-models/Inconsistency.js";
import {
  decodeObject,
  encodeObject,
  formatPromptInconsistencies,
  handleLangchainError,
} from "@/utils/llmHelper.js";
import { config } from "@/utils/config.js";
import { type ConsistencyState } from "./state.js";
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

type DecreaseConsistencyIterationOutput = Pick<
  ConsistencyState,
  "loopIterationsRemaining"
>;
/**
 * Decreases the remaining inconsistency iterations by one.
 */
export function decreaseConsistencyIteration(
  state: ConsistencyState
): DecreaseConsistencyIterationOutput {
  console.debug(
    `[Consistency: DecreaseConsistencyIteration] Remaining iterations after decrement: ${state.loopIterationsRemaining - 1}`
  );

  return {
    loopIterationsRemaining: state.loopIterationsRemaining - 1,
  };
}

export function checkRemainingIterations(
  state: ConsistencyState
): "run" | "skip" {
  console.debug(
    `[Consistency: CheckRemainingIterations] Remaining iterations: ${state.loopIterationsRemaining}. Should run: ${state.loopIterationsRemaining > 0}`
  );

  // compare to 0 becuase counter was decremented before this check
  return state.loopIterationsRemaining <= 0 ? "skip" : "run";
}

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

  if (!state.case) {
    throw new CaseGenerationError("Case is missing for consistency check");
  }

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

  const userPrompt = `Provided Diagnosis: ${state.diagnosis} ${state.icdCode ?? ""}
${state.context ? `\nAdditional provided context: ${state.context}` : ""}`;

  console.debug(
    `[Consistency: GenerateInconsistencies] Prompt:\n${systemPrompt}\n${userPrompt}`
  );

  try {
    const agentConfig: CreateAgentParams = {
      model: getDeterministicLLM(),
      tools: [state.icdCode ? symptomsToolForICD(state.icdCode) : symptomsTool],
      systemPrompt: systemPrompt,
      middleware: [toolCallLimitMiddleware({ runLimit: 3 })],
    };
    if (config.LLM_FORMAT === "JSON") {
      agentConfig.responseFormat = providerStrategy(
        InconsistencyArrayJsonFormatZod
      );
    }

    const parsedInconsistencies: Inconsistency[] = await retry(
      async () => {
        const text = await invokeWithTools(agentConfig, [
          new HumanMessage(userPrompt),
        ]).catch((error) => {
          handleLangchainError(error);
        });
        console.debug(
          "[Consistency: GenerateInconsistencies] LLM Response:",
          text
        );

        return await decodeObject(text)
          .then(
            (object) =>
              InconsistencyArrayJsonFormatZod.parse(object).inconsistencies
          )
          .catch(() => {
            throw new CaseGenerationError(
              `Failed to parse LLM response in ${config.LLM_FORMAT} format`
            );
          });
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
