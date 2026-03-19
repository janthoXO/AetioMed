import {
  SymptomArrayJsonExample,
  SymptomSchema,
  type Symptom,
} from "@/models/Symptom.js";
import type { Diagnosis } from "@/models/Diagnosis.js";
import { getDeterministicLLM, handleLangchainError } from "@/utils/llm.js";
import { HumanMessage, SystemMessage } from "langchain";
import z from "zod";
import { retry } from "@/utils/retry.js";
import { emitTrace } from "@/utils/tracing.js";

export async function generateSymptomsOneShot(
  diagnosis: Diagnosis,
  userInstructions?: string,
  symptomsToExclude: Symptom[] = []
): Promise<Symptom[]> {
  const systemPrompt = `You are a medical expert tasked with generating symptoms for a given diagnosis.
${
  symptomsToExclude.length > 0
    ? `\nTry to generate symptoms that are not in the list of excluded symptoms: ${symptomsToExclude.map((s) => s.name).join(", ")}`
    : ``
}
Return your response in JSON:
${JSON.stringify({ symptoms: SymptomArrayJsonExample() })}

Requirements:
- Be medically accurate and realistic
- Use standard medical terminology
- Return ONLY the JSON content, no additional text`;

  const userPrompt = [
    `Provided Diagnosis: ${diagnosis.name} ${diagnosis.icd ?? ""}`,
    userInstructions
      ? `Additional provided instructions: ${userInstructions}`
      : "",
  ]
    .filter((s) => s.length > 0)
    .join("\n");

  console.debug(
    `[GenerateSymptomsOneShot] Prompt:\n${systemPrompt}\n${userPrompt}`
  );

  // Initialize cases to empty in case of failure
  try {
    const SymptomArrayWrapperSchema = z.object({
      symptoms: SymptomSchema.array(),
    });

    const symptoms: Symptom[] = await retry(
      async (attempt: number) => {
        const result = await getDeterministicLLM()
          .withStructuredOutput(SymptomArrayWrapperSchema)
          .invoke([
            new SystemMessage(systemPrompt),
            new HumanMessage(userPrompt),
          ])
          .catch((error) => {
            handleLangchainError(error);
          });

        console.debug(
          `[GenerateSymptomsOneShot] [Attempt ${attempt}] LLM raw Response:\n`,
          JSON.stringify(result)
        );

        return result.symptoms;
      },
      2,
      0,
      (error, attempt) => {
        emitTrace(
          `[GenerateSymptomsOneShot] Attempt ${attempt} failed with error: ${error.message}`,
          { category: "error" }
        );
      }
    );

    return symptoms;
  } catch (error) {
    console.error(`[GenerateSymptomsOneShot] Error:`, error);
    throw error;
  }
}
