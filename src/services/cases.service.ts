import {
  AnamnesisCategoryDefaults,
  type AnamnesisCategory,
} from "@/domain-models/Anamnesis.js";
import {
  CaseJsonExampleString,
  CaseJsonFormatZod,
  CaseSchema,
  descriptionPromptDraft,
  type Case,
} from "@/domain-models/Case.js";
import type { GenerationFlag } from "@/domain-models/GenerationFlags.js";
import type { Language } from "@/domain-models/Language.js";
import { generateCase as graphGenerateCase } from "@/ai/case-persona-graph/index.js";
import { translateCase } from "@/ai/translation-graph/index.js";
import { translateAnamnesisCategoriesToEnglish } from "./anamnesis.service.js";
import type { Diagnosis } from "@/domain-models/Diagnosis.js";
import type { Inconsistency } from "@/domain-models/Inconsistency.js";
import {
  HumanMessage,
  providerStrategy,
  toolCallLimitMiddleware,
  type CreateAgentParams,
} from "langchain";
import {
  decodeObject,
  getCreativeLLM,
  handleLangchainError,
} from "@/ai/llm.js";
import { symptomsTool, symptomsToolForICD } from "@/ai/tools/symptoms.tool.js";
import { retry } from "@/utils/retry.js";
import { invokeWithTools } from "@/ai/llm.js";
import { GenerationError } from "@/errors/AppError.js";

export async function generateCase(
  diagnosis: Diagnosis,
  generationFlags: GenerationFlag[],
  userInstructions?: string,
  language?: Language,
  anamnesisCategories?: AnamnesisCategory[]
): Promise<Case> {
  // translate anamnesis categories to English if needed
  if (anamnesisCategories && language && language !== "English") {
    const translatedCategories = await translateAnamnesisCategoriesToEnglish(
      anamnesisCategories,
      language
    );

    anamnesisCategories = Object.values(translatedCategories);
  }

  let generatedCase = await graphGenerateCase(
    diagnosis,
    generationFlags,
    userInstructions,
    anamnesisCategories
  );

  if (language) {
    generatedCase = await translateCase(generatedCase, language);
  }

  return generatedCase;
}

export async function generateCaseOneShot(
  generationFlags: GenerationFlag[],
  diagnosis: Diagnosis,
  userInstructions?: string,
  anamnesisCategories: AnamnesisCategory[] | undefined = AnamnesisCategoryDefaults,
  previousCase?: Case,
  inconsistencies?: Inconsistency[]
): Promise<Case> {
  const systemPrompt = `You are a medical education expert creating realistic patient cases for medical students for a provided diagnosis with additional instructions.

The case should include:
${descriptionPromptDraft(generationFlags)}

Return your response in JSON ${generationFlags.includes("anamnesis") ? "with the provided anamnesis categories" : ""}:
${CaseJsonExampleString(generationFlags)}
${
  previousCase
    ? `\nPrevious case generated:\n${JSON.stringify(previousCase)}
with inconsistencies:\n${JSON.stringify(inconsistencies)}
`
    : ``
}
Requirements:
- Be medically accurate and realistic
- Do NOT directly reveal the diagnosis
- Use standard medical terminology
- If you need symptom information, call the get_symptoms_for_icd tool ONCE, then immediately proceed to generate the case
- After receiving symptom information (or if you don't need it), generate the complete case immediately
- Return ONLY the JSON content, no additional text`;

  const userPrompt = [
    `Provided Diagnosis for patient case: ${diagnosis.name} ${diagnosis.icd ?? ""}`,
    userInstructions
      ? `Additional provided instructions: ${userInstructions}`
      : "",
    generationFlags.includes("anamnesis") && anamnesisCategories
      ? `Provided anamnesis categories: ${anamnesisCategories.join(", ")}`
      : "",
  ]
    .filter((s) => s.length > 0)
    .join("\n");

  console.debug(
    `[GenerateCaseOneShot] Prompt:\n${systemPrompt}\n${userPrompt}`
  );

  // Initialize cases to empty in case of failure
  try {
    const agentConfig: CreateAgentParams = {
      model: getCreativeLLM(),
      tools: [diagnosis.icd ? symptomsToolForICD(diagnosis.icd) : symptomsTool],
      systemPrompt: systemPrompt,
      middleware: [toolCallLimitMiddleware({ runLimit: 2 })],
      responseFormat: providerStrategy(CaseJsonFormatZod(generationFlags)),
    };

    const parsedCase: Case = await retry(
      async () => {
        const text = await invokeWithTools(agentConfig, [
          new HumanMessage(userPrompt),
        ]).catch((error) => {
          handleLangchainError(error);
        });
        console.debug(`[GenerateCaseOneShot] LLM raw Response:\n${text}`);

        return await decodeObject(text)
          .then((object) => CaseSchema.parse(object))
          .catch(() => {
            throw new GenerationError(
              `Failed to parse LLM response in JSON format`
            );
          });
      },
      2,
      0
    );

    return parsedCase;
  } catch (error) {
    console.error(`[GenerateCaseOneShot] Error:`, error);
    throw error;
  }
}
