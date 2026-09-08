import { SymptomSchema, type Symptom } from "../models/Symptom.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import { getDeterministicLLM, handleLangchainError } from "../utils/llm.js";
import {
  buildPrompt,
  renderSchemaForPrompt,
  section,
  summarizeValidationError,
} from "../utils/prompt.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import z from "zod";
import { retry } from "../utils/retry.js";
import type { RequestContext } from "../utils/context.js";
import type { GraphRuntime } from "../runtime.js";

export async function generateSymptomsOneShot(
  runtime: GraphRuntime,
  diagnosis: Diagnosis,
  userInstructions?: string,
  symptomsToExclude: Symptom[] = [],
  context?: RequestContext
): Promise<Symptom[]> {
  const SymptomArrayWrapperSchema = z.object({
    symptoms: SymptomSchema.array(),
  });

  const systemPrompt = buildPrompt(
    section(
      "Role",
      `You are a medical expert tasked with generating symptoms for a given diagnosis.`
    ),

    section(
      "Requirements",
      `- Be medically accurate and realistic
- Use standard medical terminology
- Return ONLY the JSON content, no additional text`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(SymptomArrayWrapperSchema)}`
    )
  );

  const userPrompt = buildPrompt(
    section("Provided diagnosis", `${diagnosis.name} ${diagnosis.icd ?? ""}`),

    symptomsToExclude.length > 0
      ? section(
          "Excluded symptoms",
          `Try to generate symptoms that are not in this list: ${symptomsToExclude.map((s) => s.name).join(", ")}`
        )
      : undefined,

    section("Additional instructions", userInstructions)
  );

  console.debug(
    `[GenerateSymptomsOneShot] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  // Initialize cases to empty in case of failure
  try {
    const symptoms: Symptom[] = await retry(
      async (attempt: number, previousError?: Error) => {
        const result = await getDeterministicLLM(
          runtime.llm,
          context?.llmConfig
        )
          .withStructuredOutput(SymptomArrayWrapperSchema)
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
          `[GenerateSymptomsOneShot] [Attempt ${attempt}] LLM raw Response:\n`,
          JSON.stringify(result, null, 2)
        );

        return result.symptoms;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateSymptomsOneShot] Attempt ${attempt} failed with error: ${error.message}`;
        console.error(msg);
        runtime.log.error(msg);
      }
    );

    return symptoms;
  } catch (error) {
    console.error(`[GenerateSymptomsOneShot] Error:`, error);
    throw error;
  }
}
