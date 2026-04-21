import z from "zod";
import type { ForeignLanguage } from "../models/Language.js";
import type { RequestContext } from "../utils/context.js";
import { getDeterministicLLM } from "../utils/llm.js";

export async function generateDiagnosisToEnglish(
  diagnosis: string,
  language: ForeignLanguage,
  context?: RequestContext
): Promise<string> {
  const systemPrompt = `Translate the provided diagnosis from the provided language to English:

Return the english diagnosis in a JSON
{
  "diagnosis": "diagnosis in English"
}
`;

  const userPrompt = `Source language: ${language}
Target language: English
Diagnosis to translate:
${diagnosis}`;

  console.debug(
    `[GenerateDiagnosisToEnglish] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  const prompt = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  const responseSchema = z.object({
    diagnosis: z.string(),
  });

  const response = await getDeterministicLLM(context?.llmConfig)
    .withStructuredOutput(responseSchema)
    .invoke(prompt);

  console.debug(
    `[GenerateDiagnosisToEnglish] Generated diagnosis translation:\n${response.diagnosis}`
  );

  return response.diagnosis;
}
