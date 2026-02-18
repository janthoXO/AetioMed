import { getLLM, parseStructuredResponse } from "@/02ai/llm.js";
import { type GlobalState } from "./state.js";
import { type AnamnesisCategory } from "@/02domain-models/Anamnesis.js";
import { CaseJsonExampleString, CaseSchema } from "@/02domain-models/Case.js";
import { HumanMessage, SystemMessage } from "langchain";
import { retry } from "@/utils/retry.js";
import { GenerationError } from "@/errors/AppError.js";
import { translateAnamnesisCategoriesFromEnglish } from "@/02services/anamnesis.service.js";
import { translateProceduresFromEnglish } from "@/02services/procedures.service.js";

type TranslateCaseOutput = Pick<GlobalState, "case">;

export async function translateAnamnesisCategory(
  state: GlobalState
): Promise<TranslateCaseOutput> {
  console.debug(
    "[Translation: TranslateCase] Translating anamnesis category to",
    state.language
  );

  const anamnesisCategories =
    state.case.anamnesis?.map(
      (anamnesis) => anamnesis.category as AnamnesisCategory
    ) ?? [];

  if (anamnesisCategories.length === 0) {
    console.debug(
      "[Translation: TranslateCase] No anamnesis categories to translate."
    );
    return { case: state.case };
  }

  const categoryTranslations = await translateAnamnesisCategoriesFromEnglish(
    anamnesisCategories,
    state.language
  );

  state.case.anamnesis = state.case.anamnesis?.map((anamnesis) => {
    return {
      ...anamnesis,
      category: categoryTranslations[anamnesis.category as AnamnesisCategory]!,
    };
  });

  return { case: state.case };
}

export async function translateProcedures(
  state: GlobalState
): Promise<TranslateCaseOutput> {
  console.debug(
    "[Translation: TranslateCase] Translating procedures to",
    state.language
  );

  if (!state.case.procedures?.length) {
    console.debug("[Translation: TranslateCase] No procedures to translate.");
    return { case: state.case };
  }

  const englishProcedures = await translateProceduresFromEnglish(
    state.case.procedures,
    state.language
  );

  state.case.procedures = state.case.procedures?.map((procedure, index) => {
    return {
      ...procedure,
      ...englishProcedures[index],
    };
  });

  return { case: state.case };
}

export async function translateValues(
  state: GlobalState
): Promise<TranslateCaseOutput> {
  console.debug(
    "[Translation: TranslateCase] Translating case to",
    state.language
  );

  const systemPrompt = `You are a medical translator.
Your task is to translate the provided medical case JSON content into ${state.language}.

Return your response in JSON:
${CaseJsonExampleString(state.generationFlags)}
${state.generationFlags.includes("procedures") ? "Do NOT translate the procedures relevance field, keep it as is." : ""}
RULES:
1. Preserve the structure exactly.
2. Translate only the VALUES. Do not translate keys.
3. Return ONLY the JSON content, no additional text`;

  const userPrompt = `Case to translate:
${JSON.stringify(state.case)}`;

  console.debug(
    `[Translation: TranslateCase] Prompt: ${systemPrompt}\n\n${userPrompt}`
  );

  try {
    // Direct LLM invoke (Chat Model)
    const llm = getLLM();
    const messages = [
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ];

    const translatedCase = await retry(
      async () => {
        try {
          // const caseObject = await llm
          //   .withStructuredOutput(CaseSchemaWithLanguage(state.language))
          //   .invoke(messages);

          const result = await llm.invoke(messages);

          console.debug(
            "[Translation: TranslateCase] LLM Response:",
            result.text
          );

          return parseStructuredResponse(result.text, CaseSchema);
        } catch {
          throw new GenerationError(
            `Failed to parse LLM response in JSON format`
          );
        }
      },
      2,
      0
    );

    return {
      case: translatedCase,
    };
  } catch (error) {
    console.error("[Translation: TranslateCase] Error:", error);
    throw error;
  }
}
