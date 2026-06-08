import z from "zod";
import type { ForeignLanguage } from "../models/Language.js";
import type { RequestContext } from "../utils/context.js";
import { buildPrompt, getDeterministicLLM } from "../utils/llm.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

export async function generateDiagnosisToEnglish(
  diagnosis: string,
  language: ForeignLanguage,
  context?: RequestContext
): Promise<string> {
  const systemPrompt = buildPrompt(
    `Translate the provided diagnosis from the provided language to English.`,
    `Return the English diagnosis in a JSON\n{\n  "diagnosis": "diagnosis in English"\n}`
  );

  const userPrompt = buildPrompt(
    `Source language: ${language}`,
    `Target language: English`,
    `Diagnosis to translate:\n${diagnosis}`
  );

  console.debug(
    `[GenerateDiagnosisToEnglish] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  const responseSchema = z.object({
    diagnosis: z.string(),
  });

  const response = await getDeterministicLLM(context?.llmConfig)
    .withStructuredOutput(responseSchema)
    .invoke([new SystemMessage(systemPrompt), new HumanMessage(userPrompt)]);

  console.debug(
    `[GenerateDiagnosisToEnglish] Generated diagnosis translation:\n${response.diagnosis}`
  );

  return response.diagnosis;
}
