import { invokeWithTools } from "@/ai/invokeWithTool.js";
import {
  decodeObject,
  getDeterministicLLM,
  handleLangchainError,
} from "@/ai/llm.js";
import { symptomsTool, symptomsToolForICD } from "@/ai/tools/symptoms.tool.js";
import type { Case } from "@/domain-models/Case.js";
import type { Diagnosis } from "@/domain-models/Diagnosis.js";
import {
  InconsistencyArrayJsonFormatZod,
  InconsistencyJsonExampleString,
  type Inconsistency,
} from "@/domain-models/Inconsistency.js";
import { CaseGenerationError } from "@/errors/AppError.js";
import { retry } from "@/utils/retry.js";
import {
  HumanMessage,
  providerStrategy,
  toolCallLimitMiddleware,
  type CreateAgentParams,
} from "langchain";

export async function generateInconsistenciesOneShot(
  caseToCheck: Case,
  diagnosis: Diagnosis,
  context?: string
): Promise<Inconsistency[]> {
  const systemPrompt = `You are a medical quality assurance expert validating a patient case for educational use with a provided diagnosis and additional context.

Case to validate:
${JSON.stringify(caseToCheck)}

Check for these types of inconsistencies:
1. Is the diagnosis not directly revealed in the case?
2. Are all entries internally consistent and support each other?

Return your response in JSON:
${`{ inconsistencies: [
${InconsistencyJsonExampleString()},
...] }`}
or an empty list if no inconsistencies are found.
${JSON.stringify({ inconsistencies: [] })} 

Requirements:
- Be thorough but fair
- If you need symptom information, call the get_symptoms_for_icd tool ONCE, then immediately proceed to generate the inconsistencies
- Only flag genuine medical/logical inconsistencies
- Don't be overly pedantic
- Return ONLY the JSON content`;

  const userPrompt = `Provided Diagnosis: ${diagnosis.name} ${diagnosis.icd ?? ""}
${context ? `\nAdditional provided context: ${context}` : ""}`;

  console.debug(
    `[Consistency: GenerateInconsistencies] Prompt:\n${systemPrompt}\n${userPrompt}`
  );

  try {
    const agentConfig: CreateAgentParams = {
      model: getDeterministicLLM(),
      tools: [diagnosis.icd ? symptomsToolForICD(diagnosis.icd) : symptomsTool],
      systemPrompt: systemPrompt,
      middleware: [toolCallLimitMiddleware({ runLimit: 3 })],
      responseFormat: providerStrategy(InconsistencyArrayJsonFormatZod),
    };

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
              `Failed to parse LLM response in JSON format`
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

    return parsedInconsistencies.sort((a, b) => (a.field > b.field ? 1 : -1));
  } catch (error) {
    console.error("[Consistency: GenerateInconsistencies] Error:", error);
    throw error;
  }
}
