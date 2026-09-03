import type { Diagnosis } from "../models/Diagnosis.js";
import { bus } from "@/core/graph/index.js";
import { PatientSchema, type Patient } from "../models/Patient.js";
import { getCreativeLLM, handleLangchainError } from "../utils/llm.js";
import {
  buildPrompt,
  renderSchemaForPrompt,
  section,
  summarizeValidationError,
} from "../utils/prompt.js";
import { retry } from "../utils/retry.js";
import type { RequestContext } from "../utils/context.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

export async function generatePatient(
  diagnosis: Diagnosis, // provided by the user
  outline: string,
  userInstructions?: string, // provided by the user | undefined
  context?: RequestContext
): Promise<Patient> {
  const systemPrompt = buildPrompt(
    section(
      "Role",
      `You are an expert medical educator authoring a realistic clinical patient file for a medical training simulator.
Your current task is to render the Patient Demographics specified in the provided Case Outline into the required JSON format. The outline is the single source of truth — you do not decide any clinical facts yourself.`
    ),

    section(
      "Requirements",
      `- Take the demographics and biometrics (Age, Gender, Height in cm, Weight in kg) EXACTLY as specified in the outline. Do not change or invent any of these values.
- Your only own contribution is a realistic, culturally appropriate full name matching the outline's demographics.
- Return ONLY the JSON object, no additional text like prefix or suffix.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(PatientSchema)}`
    )
  );

  const userPrompt = buildPrompt(
    section("Target diagnosis", `${diagnosis.name} ${diagnosis.icd ?? ""}`),

    section("Case outline", outline),

    section("Additional instructions", userInstructions)
  );

  console.debug(
    `[GeneratePatientFromOutline] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const patient: Patient = await retry(
      async (attempt: number, previousError?: Error) => {
        const result = await getCreativeLLM(context?.llmConfig)
          .withStructuredOutput(PatientSchema)
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
          `[GeneratePatientFromOutline] [Attempt ${attempt}] LLM raw Response:\n`,
          JSON.stringify(result, null, 2)
        );

        return result;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GeneratePatientFromOutline] Attempt ${attempt} failed with error: ${error.message}`;
        console.error(msg);
        bus.emit("Generation Log", {
          msg,
          logLevel: "error",
          timestamp: new Date().toISOString(),
        });
      }
    );

    return patient;
  } catch (error) {
    console.error(`[GeneratePatientFromOutline] Error:`, error);
    throw error;
  }
}
