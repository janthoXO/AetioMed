import {
  SymptomArrayJsonExample,
  SymptomSchema,
  type Symptom,
} from "@/domain-models/Symptom.js";
import symptomData from "../data/disease_symptoms.json" with { type: "json" };
import type { Diagnosis, ICDCode } from "@/domain-models/Diagnosis.js";
import {
  decodeObject,
  getDeterministicLLM,
  handleLangchainError,
  invokeWithTools,
} from "@/ai/llm.js";
import {
  HumanMessage,
  providerStrategy,
  type CreateAgentParams,
} from "langchain";
import z from "zod";
import { retry } from "@/utils/retry.js";
import { GenerationError } from "@/errors/AppError.js";

const symptomMap = symptomData as Record<string, { symptoms: Symptom[] }>;

export function SymptomsRelatedToDiseaseIcd(icdCode: ICDCode): Symptom[] {
  return symptomMap[icdCode]?.symptoms || [];
}

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

    const agentConfig: CreateAgentParams = {
      model: getDeterministicLLM(),
      tools: [],
      systemPrompt: systemPrompt,
      responseFormat: providerStrategy(SymptomArrayWrapperSchema),
    };

    const symptoms: Symptom[] = await retry(
      async () => {
        const text = await invokeWithTools(agentConfig, [
          new HumanMessage(userPrompt),
        ]).catch((error) => {
          handleLangchainError(error);
        });
        console.debug(`[GenerateSymptomsOneShot] LLM raw Response:\n${text}`);

        return await decodeObject(text)
          .then((object) => SymptomArrayWrapperSchema.parse(object).symptoms)
          .catch(() => {
            throw new GenerationError(
              `Failed to parse LLM response in JSON format`
            );
          });
      },
      2,
      0
    );

    return symptoms;
  } catch (error) {
    console.error(`[GenerateSymptomsOneShot] Error:`, error);
    throw error;
  }
}
