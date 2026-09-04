import { START, StateGraph, END, Send } from "@langchain/langgraph";
import { CaseTranslationToEnglishStateSchema } from "./state.js";
import { RequestContextSchema } from "@/core/graph/utils/context.js";
import { type CaseTranslationToEnglishState } from "./state.js";
import { translationToEnglishTools } from "./tools.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { Runtime } from "@langchain/langgraph";
import type { RequestContext } from "@/core/graph/utils/context.js";

function makeTranslateDiagnosis(runtime: GraphRuntime) {
  return async function translateDiagnosis(
    state: CaseTranslationToEnglishState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<CaseTranslationToEnglishState, "diagnosis"> | undefined> {
    const diagnosis =
      await translationToEnglishTools.translateDiagnosisToEnglish.invoke(
        {
          diagnosis: state.diagnosis,
          language: state.language,
        },
        runtime,
        lgRuntime?.context
      );
    return { diagnosis };
  };
}

export function buildCaseTranslationToEnglishGraph(
  runtime: GraphRuntime,
  traceNode: ReturnType<typeof createTraceNode>
) {
  return new StateGraph(
    CaseTranslationToEnglishStateSchema,
    RequestContextSchema
  )
    .addNode(
      "translate_diagnosis",
      traceNode(
        "translate_diagnosis",
        makeTranslateDiagnosis(runtime),
        "Translating diagnosis to English"
      )
    )

    .addConditionalEdges(START, (state) => [
      new Send("translate_diagnosis", state),
    ])
    .addEdge("translate_diagnosis", END)
    .compile();
}
