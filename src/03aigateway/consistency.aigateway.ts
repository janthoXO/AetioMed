import {
  buildPrompt,
  getDeterministicLLM,
  handleLangchainError,
} from "@/utils/llm.js";
import type { Case } from "@/models/Case.js";
import type { Diagnosis } from "@/models/Diagnosis.js";
import {
  InconsistencyArrayJsonFormatZod,
  InconsistencyJsonExampleString,
  type Inconsistency,
} from "@/models/Inconsistency.js";
import type { Symptom } from "@/models/Symptom.js";
import { retry } from "@/utils/retry.js";
import { HumanMessage, SystemMessage } from "langchain";
import type { GenerationFlag } from "@/models/GenerationFlags.js";
import type { RequestContext } from "@/utils/context.js";

export async function generateInconsistenciesFromOutline(
  caseToCheck: Case,
  diagnosis: Diagnosis,
  generationFlags: GenerationFlag[],
  userInstructions?: string,
  context?: RequestContext
): Promise<Inconsistency[]> {
  const systemPrompt = buildPrompt(
    `You are an expert Medical Quality Assurance Reviewer evaluating a generated clinical mock case for a medical training simulator. Your task is to identify clinical, logical, or pedagogical inconsistencies across the generated fields.`,

    `CRITICAL EVALUATION CRITERIA:
1. Diagnosis Secrecy (Pedagogical): The target diagnosis MUST NOT be explicitly named in any of the fields (the student is supposed to deduce it).
2. Clinical Coherence: Do the fields logically align? (e.g., Do the Procedures make sense for the Chief Complaint? Does the Anamnesis contradict the Patient's age/gender?)
3. Realism: Are there impossible biometric values (e.g., a 2-year-old weighing 70kg), contradictory timelines, or medical hallucinations?`,

    `When creating an inconsistency record, ensure the "suggestion" field provides a highly specific, actionable directive. This suggestion will be fed directly to the AI regenerating that specific field. Tell it EXACTLY how to fix the error.`,

    `Return ONLY a valid JSON object matching the schema below.
Schema:
${`{ inconsistencies: [
${InconsistencyJsonExampleString(generationFlags)},
...] }`}
Valid empty state:
${JSON.stringify({ inconsistencies: [] })} `,

    `Requirements:
- Be thorough but fair.
- Only flag genuine medical, logical, or pedagogical errors. Do not flag stylistic choices.
- Return ONLY the JSON content, no additional text like prefix or suffix.`
  );

  const userPrompt = buildPrompt(
    `Target Diagnosis: ${diagnosis.name} ${diagnosis.icd ?? ""}`,

    `Generated Case Data to Validate:\n${JSON.stringify(caseToCheck, null, 2)}`,

    userInstructions
      ? `Additional Instructions: ${userInstructions}`
      : undefined
  );

  console.debug(
    `[Consistency: GenerateInconsistencies] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const parsedInconsistencies: Inconsistency[] = await retry(
      async (attempt: number) => {
        const result = await getDeterministicLLM(context?.llmConfig)
          .withStructuredOutput(InconsistencyArrayJsonFormatZod)
          .invoke([
            new SystemMessage(systemPrompt),
            new HumanMessage(userPrompt),
          ])
          .catch((error) => {
            handleLangchainError(error);
          });

        console.debug(
          `[GenerateInconsistenciesOneShot] [Attempt ${attempt}] LLM raw Response:\n`,
          JSON.stringify(result, null, 2)
        );

        return result.inconsistencies;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateInconsistenciesOneShot] Attempt ${attempt} failed with error: ${error.message}`;
        console.error(msg);
        context?.traceUtils?.emitTrace(msg, { category: "error" });
      }
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

export async function generateInconsistenciesOneShot(
  caseToCheck: Case,
  diagnosis: Diagnosis,
  generationFlags: GenerationFlag[],
  symptoms: Symptom[] = [],
  userInstructions?: string,
  context?: RequestContext
): Promise<Inconsistency[]> {
  const systemPrompt = `You are a medical quality assurance expert validating a patient case for educational use with a provided diagnosis and additional user instructions.

Case to validate:
${JSON.stringify(caseToCheck)}

Check for these types of inconsistencies:
1. Is the diagnosis not directly revealed in the case?
2. Are all entries internally consistent and support each other?

Return your response in JSON:
${`{ inconsistencies: [
${InconsistencyJsonExampleString(generationFlags)},
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
    `[Consistency: GenerateInconsistencies] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const parsedInconsistencies: Inconsistency[] = await retry(
      async (attempt: number) => {
        const result = await getDeterministicLLM(context?.llmConfig)
          .withStructuredOutput(InconsistencyArrayJsonFormatZod)
          .invoke([
            new SystemMessage(systemPrompt),
            new HumanMessage(userPrompt),
          ])
          .catch((error) => {
            handleLangchainError(error);
          });

        console.debug(
          `[GenerateInconsistenciesOneShot] [Attempt ${attempt}] LLM raw Response:\n`,
          JSON.stringify(result, null, 2)
        );

        return result.inconsistencies;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateInconsistenciesOneShot] Attempt ${attempt} failed with error: ${error.message}`;
        console.error(msg);
        context?.traceUtils?.emitTrace(msg, { category: "error" });
      }
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
