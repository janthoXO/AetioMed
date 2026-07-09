import z from "zod";
import type { ForeignLanguage } from "../models/Language.js";
import type { RequestContext } from "../utils/context.js";
import { getDeterministicLLM } from "../utils/llm.js";
import {
  buildPrompt,
  renderSchemaForPrompt,
  section,
} from "../utils/prompt.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

const responseSchema = z.object({
  diagnosis: z.string().describe("the diagnosis translated to English"),
});

export async function generateDiagnosisToEnglish(
  diagnosis: string,
  language: ForeignLanguage,
  context?: RequestContext
): Promise<string> {
  const systemPrompt = buildPrompt(
    section(
      "Role",
      `Translate the provided diagnosis from the provided language to English.`
    ),
    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(responseSchema)}`
    )
  );

  const userPrompt = buildPrompt(
    section("Source language", language),
    section("Target language", "English"),
    section("Diagnosis to translate", diagnosis)
  );

  console.debug(
    `[GenerateDiagnosisToEnglish] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  const response = await getDeterministicLLM(context?.llmConfig)
    .withStructuredOutput(responseSchema)
    .invoke(
      [new SystemMessage(systemPrompt), new HumanMessage(userPrompt)],
      context?.signal !== undefined ? { signal: context.signal } : undefined
    );

  console.debug(
    `[GenerateDiagnosisToEnglish] Generated diagnosis translation:\n${response.diagnosis}`
  );

  return response.diagnosis;
}
