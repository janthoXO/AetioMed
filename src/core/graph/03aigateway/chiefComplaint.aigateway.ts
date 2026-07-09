import { getCreativeLLM, handleLangchainError } from "../utils/llm.js";
import {
  buildPrompt,
  renderSchemaForPrompt,
  section,
  summarizeValidationError,
} from "../utils/prompt.js";
import { bus } from "@/core/graph/index.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { retry } from "../utils/retry.js";
import {
  ChiefComplaintJsonSchema,
  type ChiefComplaint,
} from "../models/ChiefComplaint.js";
import type { RequestContext } from "../utils/context.js";

export async function generateChiefComplaint(
  diagnosis: Diagnosis, // provided by the user
  outline: string,
  userInstructions?: string, // provided by the user | undefined
  context?: RequestContext
): Promise<ChiefComplaint> {
  const systemPrompt = buildPrompt(
    section(
      "Role",
      `You are an expert attending physician documenting a patient's presentation for a medical training simulator.
Your current task is to generate the Chief Complaint based on the provided Case Outline.`
    ),

    section(
      "Requirements",
      `- The text inside the JSON must be written from the perspective of a medical professional writing in a clinical chart.
- Use concise, objective clinical language and standard medical terminology (e.g., "acute onset dyspnea" instead of "shortness of breath").
- Ensure it directly aligns with the demographic data and symptoms specified in the outline.
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
    const chiefComplaint: ChiefComplaint = await retry(
      async (attempt: number, previousError?: Error) => {
        const result = await getCreativeLLM(context?.llmConfig)
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
        bus.emit("Generation Log", {
          msg,
          logLevel: "error",
          timestamp: new Date().toISOString(),
        });
      }
    );

    return chiefComplaint;
  } catch (error) {
    console.error(`[GenerateChiefComplaintFromOutline] Error:`, error);
    throw error;
  }
}
