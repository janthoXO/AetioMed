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
Your current task is to generate the Patient Demographics based on the provided Case Outline.`
    ),

    section(
      "Requirements",
      `- Epidemiology: The demographics (Age, Gender, Race) MUST logically align with the typical epidemiology of the Target Diagnosis unless the outline specifies otherwise.
- Biometrics: Ensure Height (in cm) and Weight (in kg) produce a realistic BMI that is clinically appropriate for the patient's presentation and diagnosis.
- Generate a realistic, culturally appropriate full name based on the chosen demographics.
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
