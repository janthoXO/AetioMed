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

  .addConditionalEdges(START, (state) => [
    new Send("translate_diagnosis", state),
  ])
  .addEdge("translate_diagnosis", END)
  .compile();
