import {
  buildPrompt,
  getDeterministicLLM,
  handleLangchainError,
} from "../utils/llm.js";
import { bus } from "@/extensions/core/index.js";
import {
  CaseJsonExampleString,
  CaseSchema,
  type Case,
} from "../models/Case.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import {
  InconsistencyArrayJsonFormatZod,
  InconsistencyJsonExampleString,
  type Inconsistency,
} from "../models/Inconsistency.js";
import { retry } from "../utils/retry.js";
import { HumanMessage, SystemMessage } from "langchain";
import type { GenerationFlag } from "../models/GenerationFlags.js";
import type { RequestContext } from "../utils/context.js";

export async function generateInconsistencies(
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
        bus.emit("Generation Log", {
          msg,
          logLevel: "error",
          timestamp: new Date().toISOString(),
        });
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

export async function fixCaseInconsistencies(
  inconsistentCase: Case,
  inconsistencies: Inconsistency[],
  generationFlags: GenerationFlag[],
  userInstructions?: string,
  context?: RequestContext
): Promise<Case> {
  const systemPrompt = buildPrompt(
    `You are an expert medical educator tasked with fixing a generated clinical mock case for a medical training simulator.`,

    `The previous case generation contained clinical or logical inconsistencies. Regenerate the JSON and fix the given issues.`,

    `Return your response in same JSON schema as the original case.
Schema:
${CaseJsonExampleString(generationFlags)}`
  );

  const userPrompt = buildPrompt(
    `Original Case:
${JSON.stringify(inconsistentCase, null, 2)})}`,

    `Inconsistencies to Fix:
${inconsistencies.map((i, idx) => `${idx + 1}. [Severity ${i.severity}] ${i.description}\n   Suggested Fix: ${i.suggestion}`).join("\n")}`,

    userInstructions
      ? `Additional Instructions: ${userInstructions}`
      : undefined
  );

  console.debug(
    `[Consistency: FixCaseInconsistencies] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const parsedCase: Case = await retry(
      async (attempt: number, previousError?: Error) => {
        const result = await getDeterministicLLM(context?.llmConfig)
          .withStructuredOutput(CaseSchema)
          .invoke([
            new SystemMessage(systemPrompt),
            new HumanMessage(
              userPrompt +
                (previousError
                  ? `\nPrevious attempt failed with error: ${previousError.message}`
                  : "")
            ),
          ])
          .catch((error) => {
            handleLangchainError(error);
          });

        console.debug(
          `[FixCaseInconsistencies] [Attempt ${attempt}] LLM raw Response:\n`,
          JSON.stringify(result, null, 2)
        );

        return result;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[FixCaseInconsistencies] Attempt ${attempt} failed with error: ${error.message}`;
        console.error(msg);
        bus.emit("Generation Log", {
          msg,
          logLevel: "error",
          timestamp: new Date().toISOString(),
        });
      }
    );

    console.debug(
      "[Consistency: FixCaseInconsistencies] Parsed Case:",
      parsedCase
    );

    return parsedCase;
  } catch (error) {
    console.error("[Consistency: FixCaseInconsistencies] Error:", error);
    throw error;
  }
}
