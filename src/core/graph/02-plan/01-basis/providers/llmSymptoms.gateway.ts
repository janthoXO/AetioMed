import {
  SymptomSchema,
  type Symptom,
} from "@/core/graph/02-plan/01-basis/symptom.js";
import type { Diagnosis } from "@/core/graph/shared/domain/Diagnosis.js";
import {
  buildPrompt,
  renderSchemaForPrompt,
  section,
  summarizeValidationError,
} from "@/core/graph/shared/prompt/prompt.js";
import z from "zod";
import { retry } from "@/core/graph/shared/prompt/retry.js";
import type { RequestContext } from "@/core/graph/utils/context.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

export async function generateSymptomsOneShot(
  runtime: GraphRuntime,
  diagnosis: Diagnosis,
  userInstructions?: string,
  context?: RequestContext
): Promise<Symptom[]> {
  const SymptomArrayWrapperSchema = z.object({
    symptoms: SymptomSchema.array(),
  });

  // Internal: feeds the plan, not the student; English always.
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

    section("Additional instructions", userInstructions)
  );

  console.debug(
    `[GenerateSymptomsOneShot] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  // Initialize cases to empty in case of failure
  try {
    const symptoms: Symptom[] = await retry(
      async (attempt: number, previousError?: Error) => {
        const result = await runtime.llm.structured(
          { role: "generator", temperature: "deterministic" },
          {
            system: systemPrompt,
            user:
              userPrompt +
              (previousError
                ? `\n\nPrevious generation error: ${summarizeValidationError(previousError)}`
                : ""),
          },
          SymptomArrayWrapperSchema,
          context
        );

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
