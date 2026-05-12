import { START, StateGraph, END, Send } from "@langchain/langgraph";
import { CaseTranslationToEnglishStateSchema } from "./state.js";
import { RequestContextSchema } from "@/extensions/core/utils/context.js";
import { type CaseTranslationToEnglishState } from "./state.js";
import { translateAnamnesisCategoriesToEnglish } from "../../02services/anamnesis.service.js";
import { translateDiagnosisToEnglish } from "../../02services/diagnosis.service.js";

export async function translateDiagnosis(
  state: CaseTranslationToEnglishState
): Promise<Pick<CaseTranslationToEnglishState, "diagnosis"> | undefined> {
  const translatedDiagnosis = await translateDiagnosisToEnglish(
    state.diagnosis,
    state.language
  );

  return { diagnosis: translatedDiagnosis };
}

export async function translateAnamnesisCategory(
  state: CaseTranslationToEnglishState
): Promise<
  Pick<CaseTranslationToEnglishState, "anamnesisCategories"> | undefined
> {
  const translatedCategories = await translateAnamnesisCategoriesToEnglish(
    state.anamnesisCategories!,
    state.language
  );

  return { anamnesisCategories: Object.values(translatedCategories) };
}

export const caseTranslationToEnglishGraph = new StateGraph(
  CaseTranslationToEnglishStateSchema,
  RequestContextSchema
)
  .addNode("translate_diagnosis", translateDiagnosis)
  .addNode("translate_anamnesis_category", translateAnamnesisCategory)

  .addConditionalEdges(START, (state) => {
    const sends: Send[] = [new Send("translate_diagnosis", state)];

    if (state.anamnesisCategories && state.anamnesisCategories.length > 0) {
      sends.push(new Send("translate_anamnesis_category", state));
    }
    return sends;
  })
  .addEdge("translate_diagnosis", END)
  .addEdge("translate_anamnesis_category", END)
  .compile();
