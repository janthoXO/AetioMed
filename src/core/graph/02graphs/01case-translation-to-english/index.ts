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

function requiredTargetLanguage(): string {
  // Read off ALS, not graph state (issue 09 §2) — this phase is only ever
  // entered when `requestNeedsTranslation` (`caseGraph.ts`) already found
  // a bound, non-English language, so an absent value here is a real bug,
  // not a legitimate "no language" case.
  const language = getRequestContext()?.language;
  if (!language) {
    throw new GenerationError(
      "translate-to-english reached without a language bound on the request context"
    );
  }
  return language;
}

function makeTranslateDiagnosis(runtime: GraphRuntime) {
  return async function translateDiagnosis(
    state: CaseTranslationToEnglishState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<CaseTranslationToEnglishState, "diagnosis">> {
    const language = requiredTargetLanguage();

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

/**
 * Issue 12 §3: `userInstructions` is free text supplied by the caller and
 * must be translated to English alongside `diagnosis`, or it flows into
 * English generation prompts unmodified. Writes only `userInstructions` —
 * disjoint from `translateDiagnosis`'s `diagnosis`, so both run in parallel
 * from `START` with no merge needed.
 */
function makeTranslateUserInstructions(runtime: GraphRuntime) {
  return async function translateUserInstructions(
    state: CaseTranslationToEnglishState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<
    Pick<CaseTranslationToEnglishState, "userInstructions"> | undefined
  > {
    const language = requiredTargetLanguage();

    if (
      !state.userInstructions ||
      Object.keys(state.userInstructions).length === 0
    ) {
      return undefined;
    }

    const userInstructions =
      await translationToEnglishTools.translateUserInstructionsToEnglish.invoke(
        {
          userInstructions: state.userInstructions,
          language,
        },
        runtime,
        lgRuntime?.context
      );
    return { userInstructions };
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
    .addNode(
      "translate_user_instructions",
      traceNode(
        "translate_user_instructions",
        makeTranslateUserInstructions(runtime),
        "Translating user instructions to English"
      )
    )

    .addConditionalEdges(START, (state) => [
      new Send("translate_diagnosis", state),
      new Send("translate_user_instructions", state),
    ])
    .addEdge("translate_diagnosis", END)
    .addEdge("translate_user_instructions", END)
    .compile();
}
