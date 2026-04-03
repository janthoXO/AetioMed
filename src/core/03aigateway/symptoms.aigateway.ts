import {
  SymptomArrayJsonExample,
  SymptomSchema,
  type Symptom,
} from "@/core/models/Symptom.js";
import { publishEvent } from "@/core/eventBus/index.js";
import type { Diagnosis } from "@/core/models/Diagnosis.js";
import { getDeterministicLLM, handleLangchainError } from "@/core/utils/llm.js";
import { HumanMessage, SystemMessage } from "langchain";
import z from "zod";
import { retry } from "@/core/utils/retry.js";
import type { RequestContext } from "@/core/utils/context.js";

export async function generateSymptomsOneShot(
  diagnosis: Diagnosis,
  userInstructions?: string,
  symptomsToExclude: Symptom[] = [],
  context?: RequestContext
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
    `[GenerateSymptomsOneShot] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  // Initialize cases to empty in case of failure
  try {
    const SymptomArrayWrapperSchema = z.object({
      symptoms: SymptomSchema.array(),
    });

    const symptoms: Symptom[] = await retry(
      async () => {
        const result = await getDeterministicLLM(context?.llmConfig)
          .withStructuredOutput(SymptomArrayWrapperSchema)
          .invoke([
            new SystemMessage(systemPrompt),
            new HumanMessage(userPrompt),
          ])
          .catch((error) => {
            handleLangchainError(error);
          });

        console.debug(
          `[GenerateSymptomsOneShot] LLM raw Response:\n`,
          JSON.stringify(result, null, 2)
        );

        return result.symptoms;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateSymptomsOneShot] Attempt ${attempt} failed with error: ${error.message}`;
        console.error(msg);
        publishEvent("Generation Log", {
          msg,
          logLevel: "error",
          timestamp: new Date().toISOString(),
        });
      }
    );

    return symptoms;
  } catch (error) {
    console.error(`[GenerateSymptomsOneShot] Error:`, error);
    throw error;
  }
}
