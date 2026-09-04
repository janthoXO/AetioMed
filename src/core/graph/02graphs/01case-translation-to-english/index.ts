import { START, StateGraph, END, Send } from "@langchain/langgraph";
import { CaseTranslationToEnglishStateSchema } from "./state.js";
import {
  RequestContextSchema,
  getRequestContext,
} from "@/core/graph/utils/context.js";
import { type CaseTranslationToEnglishState } from "./state.js";
import { translationToEnglishTools } from "./tools.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { Runtime } from "@langchain/langgraph";
import type { RequestContext } from "@/core/graph/utils/context.js";
import { GenerationError } from "@/core/graph/errors/AppError.js";

function makeTranslateDiagnosis(runtime: GraphRuntime) {
  return async function translateDiagnosis(
    state: CaseTranslationToEnglishState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<CaseTranslationToEnglishState, "diagnosis"> | undefined> {
    // Read off ALS, not graph state (issue 09 §2) — this phase is only ever
    // entered when `requestNeedsTranslation` (`caseGraph.ts`) already found
    // a bound, non-English language, so an absent value here is a real bug,
    // not a legitimate "no language" case.
    const language = getRequestContext()?.language;
    if (!language) {
      throw new GenerationError(
        "translate_diagnosis reached without a language bound on the request context"
      );
    }

    const diagnosis =
      await translationToEnglishTools.translateDiagnosisToEnglish.invoke(
        {
          diagnosis: state.diagnosis,
          language,
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
