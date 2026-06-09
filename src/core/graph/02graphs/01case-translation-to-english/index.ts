import { START, StateGraph, END, Send } from "@langchain/langgraph";
import { CaseTranslationToEnglishStateSchema } from "./state.js";
import { RequestContextSchema } from "@/core/graph/utils/context.js";
import { type CaseTranslationToEnglishState } from "./state.js";
import { translationToEnglishTools } from "./tools.js";
import { traceNode } from "@/core/graph/utils/nodeWrapper.js";

async function translateDiagnosis(
  state: CaseTranslationToEnglishState
): Promise<Pick<CaseTranslationToEnglishState, "diagnosis"> | undefined> {
  const diagnosis =
    await translationToEnglishTools.translateDiagnosisToEnglish.invoke({
      diagnosis: state.diagnosis,
      language: state.language,
    });
  return { diagnosis };
}

async function translateAnamnesisCategory(
  state: CaseTranslationToEnglishState
): Promise<
  Pick<CaseTranslationToEnglishState, "anamnesisCategories"> | undefined
> {
  const translations =
    await translationToEnglishTools.translateAnamnesisCategoriesToEnglish.invoke(
      {
        categories: state.anamnesisCategories!,
        language: state.language,
      }
    );
  return { anamnesisCategories: Object.values(translations) };
}

export const caseTranslationToEnglishGraph = new StateGraph(
  CaseTranslationToEnglishStateSchema,
  RequestContextSchema
)
  .addNode(
    "translate_diagnosis",
    traceNode(
      "translate_diagnosis",
      translateDiagnosis,
      "Translating diagnosis to English"
    )
  )
  .addNode(
    "translate_anamnesis_category",
    traceNode(
      "translate_anamnesis_category",
      translateAnamnesisCategory,
      "Translating anamnesis categories to English"
    )
  )

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
