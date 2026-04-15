import { START, StateGraph, END } from "@langchain/langgraph";
import { CaseTranslationFromEnglishStateSchema } from "./state.js";
import { RequestContextSchema } from "@/extensions/core/utils/context.js";
import { getLLM } from "@/extensions/core/utils/llm.js";
import { type CaseTranslationFromEnglishState } from "./state.js";
import {
  CaseJsonExampleString,
  CaseSchema,
} from "@/extensions/core/models/Case.js";
import { HumanMessage, SystemMessage } from "langchain";
import { retry } from "@/extensions/core/utils/retry.js";
import { GenerationError } from "@/extensions/core/errors/AppError.js";
import { translateAnamnesisCategoriesFromEnglish } from "@/extensions/core/02services/anamnesis.service.js";
import { translateProcedureNamesFromEnglish } from "@/extensions/core/02services/procedures.service.js";
import type { RequestContext } from "@/extensions/core/utils/context.js";
import { type Runtime, Send } from "@langchain/langgraph";
import type { PickNested } from "@/extensions/core/utils/pickNested.js";

export async function translateAnamnesisCategory(
  state: CaseTranslationFromEnglishState
): Promise<
  PickNested<CaseTranslationFromEnglishState, "case", "anamnesis"> | undefined
> {
  console.debug(
    "[Translation: TranslateCase] Translating anamnesis category to",
    state.language
  );

  if (!state.case.anamnesis?.length) {
    console.debug(
      "[Translation: TranslateCase] No anamnesis categories to translate."
    );
    return undefined;
  }

  const categoryTranslations = await translateAnamnesisCategoriesFromEnglish(
    state.case.anamnesis.map((anamnesis) => anamnesis.category),
    state.language
  );

  const updatedAnamnesis = state.case.anamnesis.map((anamnesis) => {
    return {
      ...anamnesis,
      category: categoryTranslations[anamnesis.category]!,
    };
  });

  return { case: { anamnesis: updatedAnamnesis } };
}

export async function translateProcedureNames(
  state: CaseTranslationFromEnglishState
): Promise<
  PickNested<CaseTranslationFromEnglishState, "case", "procedures"> | undefined
> {
  console.debug(
    "[Translation: TranslateCase] Translating procedure names to",
    state.language
  );

  if (!state.case.procedures?.length) {
    console.debug(
      "[Translation: TranslateCase] No procedure names to translate."
    );
    return undefined;
  }

  const englishProcedures = await translateProcedureNamesFromEnglish(
    state.case.procedures.map((p) => p.name),
    state.language
  );

  const updatedProcedures = state.case.procedures.map((procedure) => {
    return {
      ...procedure,
      name: englishProcedures[procedure.name] ?? procedure.name,
    };
  });

  return { case: { procedures: updatedProcedures } };
}

export async function translateValues(
  state: CaseTranslationFromEnglishState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<CaseTranslationFromEnglishState, "case">> {
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
    const llm = getLLM(runtime?.context?.llmConfig);
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

          const result = await llm
            .withStructuredOutput(CaseSchema)
            .invoke(messages);

          console.debug("[Translation: TranslateCase] LLM Response:", result);

          return result;
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

export const caseTranslationFromEnglishGraph = new StateGraph(
  CaseTranslationFromEnglishStateSchema,
  RequestContextSchema
)
  .addNode("translate_anamnesis_category", translateAnamnesisCategory)
  .addNode("translate_procedures_names", translateProcedureNames)
  .addNode("translate_values", translateValues)

  .addConditionalEdges(START, (state): Send[] => {
    const sends: Send[] = [];
    if (state.case.anamnesis?.length) {
      sends.push(new Send("translate_anamnesis_category", state));
    }
    if (state.case.procedures?.length) {
      sends.push(new Send("translate_procedures_names", state));
    }

    if (sends.length === 0) {
      sends.push(new Send(END, state));
    }
    return sends;
  })
  .addEdge("translate_anamnesis_category", "translate_values")
  .addEdge("translate_procedures_names", "translate_values")
  .addEdge("translate_values", END)
  .compile();
