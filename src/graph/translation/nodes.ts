import { getLLM } from "@/graph/llm.js";
import { type GlobalState } from "./state.js";
import {
  AnamnesisCategory,
  AnamnesisCategoryTranslation,
} from "@/domain-models/Anamnesis.js";
import { CaseSchemaWithLanguage } from "@/domain-models/Case.js";
import {
  decodeObject,
  encodeObject,
  formatPromptDraft,
} from "@/utils/llmHelper.js";
import { config } from "@/utils/config.js";
import { HumanMessage, SystemMessage } from "langchain";
import { retry } from "@/utils/retry.js";
import { CaseGenerationError } from "@/errors/AppError.js";

type TranslateCaseOutput = Pick<GlobalState, "case">;

export function translateAnamnesisCategory(
  state: GlobalState
): TranslateCaseOutput {
  console.debug(
    "[Translation: TranslateCase] Translating anamnesis category to",
    state.language
  );

  state.case.anamnesis = state.case.anamnesis?.map((anamnesis) => {
    return {
      ...anamnesis,
      category:
        AnamnesisCategoryTranslation[anamnesis.category as AnamnesisCategory][
          state.language
        ],
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

${formatPromptDraft(state.generationFlags, state.language)}

RULES:
1. Preserve the structure exactly.
2. Translate only the VALUES. Do not translate keys.
3. Return ONLY ${config.LLM_FORMAT} format content, no additional text`;

  const userPrompt = `Case to translate:
${encodeObject(state.case)}`;

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
          let caseObject: object;
          // if (config.LLM_FORMAT === "JSON") {
          //   caseObject = await llm
          //     .withStructuredOutput(CaseSchemaWithLanguage(state.language))
          //     .invoke(messages);
          // } else {
          //   caseObject = await llm
          //     .invoke(messages)
          //     .then((response) => decodeObject(response.text));
          // }

          caseObject = await llm
            .invoke(messages)
            .then((response) => decodeObject(response.text));

          console.debug(
            "[Translation: TranslateCase] LLM Response:",
            caseObject
          );

          return CaseSchemaWithLanguage(state.language).parse(caseObject);
        } catch (error) {
          throw new CaseGenerationError(
            `Failed to parse LLM response in ${config.LLM_FORMAT} format`
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
