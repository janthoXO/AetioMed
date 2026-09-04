import { handleLangchainError } from "../utils/llm.js";
import {
  buildPrompt,
  renderSchemaForPrompt,
  section,
  summarizeValidationError,
} from "../utils/prompt.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { retry } from "../utils/retry.js";
import {
  ChiefComplaintJsonSchema,
  type ChiefComplaint,
} from "../models/ChiefComplaint.js";
import { textPart } from "../models/ContentPart.js";
import type { RequestContext } from "../utils/context.js";
import type { GraphRuntime } from "../runtime.js";

export async function generateChiefComplaint(
  runtime: GraphRuntime,
  diagnosis: Diagnosis, // provided by the user
  outline: string,
  userInstructions?: string, // provided by the user | undefined
  context?: RequestContext
): Promise<ChiefComplaint> {
  const systemPrompt = buildPrompt(
    section(
      "Role",
      `You are an expert attending physician documenting a patient's presentation for a medical training simulator.
Your current task is to rewrite the Chief Complaint facts from the provided Case Outline in clinical-chart voice. The outline is the single source of truth — you do not decide any clinical facts yourself.`
    ),

    section(
      "Requirements",
      `- The text inside the JSON must be written from the perspective of a medical professional writing in a clinical chart.
- Use concise, objective clinical language and standard medical terminology (e.g., "acute onset dyspnea" instead of "shortness of breath").
- Use ONLY the facts specified in the outline (chief complaint, demographics, symptom timeline). Do not add clinical facts not present in the outline.
- Return ONLY the JSON object, no additional text like prefix or suffix.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(ChiefComplaintJsonSchema)}`
    )
  );

  const userPrompt = buildPrompt(
    section("Target diagnosis", `${diagnosis.name} ${diagnosis.icd ?? ""}`),

    section("Case outline", outline),

    section("Additional instructions", userInstructions)
  );

  console.debug(
    `[GenerateChiefComplaintFromOutline] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  // Initialize cases to empty in case of failure
  try {
    // Field generators produce ordinary text under a z.string() schema — the
    // LLM is never asked to emit bytes (issue 11 §3/§4). Wrapped with
    // `textPart()` below to build the domain `ChiefComplaint`.
    const chiefComplaintText: string = await retry(
      async (attempt: number, previousError?: Error) => {
        // Balanced: one clinical sentence whose facts come from the outline —
        // fidelity matters more than variety.
        const result = await runtime.llm
          .for(
            { role: "generator", temperature: "balanced" },
            context?.llmConfig
          )
          .withStructuredOutput(ChiefComplaintJsonSchema)
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
          `[GenerateChiefComplaintFromOutline] [Attempt ${attempt}] LLM raw Response:\n`,
          JSON.stringify(result, null, 2)
        );

        return result.chiefComplaint;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateChiefComplaintFromOutline] Attempt ${attempt} failed with error: ${error.message}`;
        console.error(msg);
        runtime.log.error(msg);
      }
    );

    return [textPart(chiefComplaintText)];
  } catch (error) {
    console.error(`[GenerateChiefComplaintFromOutline] Error:`, error);
    throw error;
  }
}
