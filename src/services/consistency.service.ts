import {
  getDeterministicLLM,
  handleLangchainError,
  parseStructuredResponseAgent,
} from "@/ai/llm.js";
import type { Case } from "@/domain-models/Case.js";
import type { Diagnosis } from "@/domain-models/Diagnosis.js";
import {
  InconsistencyArrayJsonFormatZod,
  InconsistencyJsonExampleString,
  type Inconsistency,
} from "@/domain-models/Inconsistency.js";
import type { Symptom } from "@/domain-models/Symptom.js";
import { retry } from "@/utils/retry.js";
import { createAgent, HumanMessage, providerStrategy } from "langchain";

export async function generateInconsistenciesOneShot(
  caseToCheck: Case,
  diagnosis: Diagnosis,
  symptoms: Symptom[] = [],
  userInstructions?: string
): Promise<Inconsistency[]> {
  const systemPrompt = `You are a medical quality assurance expert validating a patient case for educational use with a provided diagnosis and additional user instructions.

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
- Only flag genuine medical/logical inconsistencies
- Don't be overly pedantic
- Return ONLY the JSON content`;

  const userPrompt = [
    `Provided Diagnosis: ${diagnosis.name} ${diagnosis.icd ?? ""}`,
    symptoms && symptoms.length > 0
      ? `Provided Symptoms: ${symptoms.map((s) => s.name).join(", ")}`
      : "",
    userInstructions
      ? `\nAdditional provided context: ${userInstructions}`
      : "",
  ]
    .filter((s) => s.length > 0)
    .join("\n");

  console.debug(
    `[Consistency: GenerateInconsistencies] Prompt:\n${systemPrompt}\n${userPrompt}`
  );

  try {
    const parsedInconsistencies: Inconsistency[] = await retry(
      async () => {
        const result = await createAgent({
          model: getDeterministicLLM(),
          tools: [],
          systemPrompt: systemPrompt,
          responseFormat: providerStrategy(InconsistencyArrayJsonFormatZod),
        })
          .invoke({ messages: [new HumanMessage(userPrompt)] })
          .catch((error) => {
            handleLangchainError(error);
          });

        console.debug(
          "[GenerateInconsistenciesOneShot] LLM raw Response:\ncontent:\n",
          result.messages[result.messages.length - 1]?.content,
          "\nstructured response:\n",
          result.structuredResponse
        );

        return parseStructuredResponseAgent(
          result,
          InconsistencyArrayJsonFormatZod
        ).inconsistencies;
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
