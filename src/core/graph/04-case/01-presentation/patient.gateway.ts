import {
  PatientSchema,
  type Patient,
} from "@/core/graph/shared/domain/Patient.js";
import {
  buildPrompt,
  renderSchemaForPrompt,
  section,
  summarizeValidationError,
} from "@/core/graph/shared/prompt/prompt.js";
import { retry } from "@/core/graph/shared/prompt/retry.js";
import type { RequestContext } from "@/core/graph/utils/context.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

export async function generatePatient(
  runtime: GraphRuntime,
  patientSection: string,
  userInstructions?: string, // provided by the user | undefined
  context?: RequestContext
): Promise<Patient> {
  // Internal (English): no free text left in `Patient`, only numbers, an enum and a name.
  const systemPrompt = buildPrompt(
    section(
      "Role",
      `You are an expert medical educator authoring a realistic clinical patient file for a medical training simulator.
Your current task is to render the patient demographics from the provided Patient section of a case outline into the required JSON format. The section is the single source of truth — you do not decide any clinical facts yourself.`
    ),

    section(
      "Requirements",
      `- Take the demographics and biometrics (Age, Gender, Height in cm, Weight in kg) EXACTLY as specified in the section. Do not change or invent any of these values.
- Your only own contribution is a realistic, culturally appropriate full name matching the section's demographics.
- Return ONLY the JSON object, no additional text like prefix or suffix.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(PatientSchema)}`
    )
  );

  const userPrompt = buildPrompt(
    section("Patient", patientSection),

    section("Additional instructions", userInstructions)
  );

  console.debug(
    `[GeneratePatientFromOutline] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const patient: Patient = await retry(
      async (attempt: number, previousError?: Error) => {
        const result = await runtime.llm.structured(
          { role: "generator", temperature: "creative" },
          {
            system: systemPrompt,
            user:
              userPrompt +
              (previousError
                ? `\n\nPrevious generation error: ${summarizeValidationError(previousError)}`
                : ""),
          },
          PatientSchema,
          context
        );

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
        runtime.log.error(msg);
      }
    );

    return patient;
  } catch (error) {
    console.error(`[GeneratePatientFromOutline] Error:`, error);
    throw error;
  }
}
