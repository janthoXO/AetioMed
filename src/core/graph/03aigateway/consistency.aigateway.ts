import { getDeterministicLLM, handleLangchainError } from "../utils/llm.js";
import {
  buildPrompt,
  renderForPrompt,
  renderSchemaForPrompt,
  section,
  summarizeValidationError,
} from "../utils/prompt.js";
import { bus } from "@/core/graph/index.js";
import { buildCaseSchema, type Case } from "../models/Case.js";
import { getEffectiveCategoryList } from "../03repo/anamnesis.repo.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import {
  InconsistencySchema,
  type Inconsistency,
} from "../models/Inconsistency.js";
import { retry } from "../utils/retry.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RequestContext } from "../utils/context.js";
import z from "zod";

export async function generateInconsistencies(
  caseToCheck: Case,
  diagnosis: Diagnosis,
  userInstructions?: string,
  context?: RequestContext
): Promise<Inconsistency[]> {
  const InconsistenciesSchema = z.object({
    inconsistencies: z.array(InconsistencySchema),
  });

  const systemPrompt = buildPrompt(
    section(
      "Role",
      `You are an expert Medical Quality Assurance Reviewer evaluating a generated clinical mock case for a medical training simulator. Your task is to identify clinical, logical, or pedagogical inconsistencies across the generated fields.`
    ),

    section(
      "Critical evaluation criteria",
      `1. Diagnosis Secrecy (Pedagogical): The target diagnosis MUST NOT be explicitly named in any of the fields (the student is supposed to deduce it).
2. Clinical Coherence: Do the fields logically align? (e.g., Do the Procedures make sense for the Chief Complaint? Does the Anamnesis contradict the Patient's age/gender?)
3. Realism: Are there impossible biometric values (e.g., a 2-year-old weighing 70kg), contradictory timelines, or medical hallucinations?`
    ),

    section(
      "Requirements",
      `- Be thorough but fair.
- Only flag genuine medical, logical, or pedagogical errors. Do not flag stylistic choices.
- When creating an inconsistency record, ensure the "suggestion" field provides a highly specific, actionable directive. This suggestion will be fed directly to the AI regenerating that specific field. Tell it EXACTLY how to fix the error.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(InconsistenciesSchema)}
If there are no genuine inconsistencies, return an empty inconsistencies array.`
    )
  );

  const userPrompt = buildPrompt(
    section("Target diagnosis", `${diagnosis.name} ${diagnosis.icd ?? ""}`),

    section("Generated case data to validate", renderForPrompt(caseToCheck)),

    section("Additional instructions", userInstructions)
  );

  console.debug(
    `[Consistency: GenerateInconsistencies] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const parsedInconsistencies: Inconsistency[] = await retry(
      async (attempt: number, previousError?: Error) => {
        const result = await getDeterministicLLM(context?.llmConfig)
          .withStructuredOutput(InconsistenciesSchema)
          .invoke(
            [
              new SystemMessage(systemPrompt),
              new HumanMessage(
                userPrompt +
                  (previousError
                    ? `\n\nPrevious generation error: ${summarizeValidationError(previousError)}`
                    : "")
              ),
            ],
            context?.signal !== undefined
              ? { signal: context.signal }
              : undefined
          )
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
  userInstructions?: string,
  context?: RequestContext
): Promise<Case> {
  const effectiveCategories = getEffectiveCategoryList(context?.language);

  const systemPrompt = buildPrompt(
    section(
      "Role",
      `You are an expert medical educator tasked with fixing a generated clinical mock case for a medical training simulator.
The previous case generation contained clinical or logical inconsistencies. Regenerate the JSON and fix the given issues.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(buildCaseSchema())}`
    )
  );

  const userPrompt = buildPrompt(
    section("Original case", renderForPrompt(inconsistentCase)),

    section(
      "Inconsistencies to fix",
      inconsistencies
        .map(
          (i, idx) =>
            `${idx + 1}. [Severity ${i.severity}] ${i.description}\n   Suggested Fix: ${i.suggestion}`
        )
        .join("\n")
    ),

    section("Additional instructions", userInstructions)
  );

  console.debug(
    `[Consistency: FixCaseInconsistencies] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const parsedCase: Case = await retry(
      async (attempt: number, previousError?: Error) => {
        const result = await getDeterministicLLM(context?.llmConfig)
          .withStructuredOutput(buildCaseSchema(effectiveCategories))
          .invoke(
            [
              new SystemMessage(systemPrompt),
              new HumanMessage(
                userPrompt +
                  (previousError
                    ? `\n\nPrevious generation error: ${summarizeValidationError(previousError)}`
                    : "")
              ),
            ],
            context?.signal !== undefined
              ? { signal: context.signal }
              : undefined
          )
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
