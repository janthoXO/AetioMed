import { START, StateGraph, END } from "@langchain/langgraph";
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
  // Read off ALS. Phase only entered when a non-English language is bound; absent = bug.
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

/** Translates caller-supplied `userInstructions`. Writes only `userInstructions`, disjoint from `translateDiagnosis`, so both run parallel from `START`. */
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

// Mounted as `translation_to_english_phase`. Output `.pick()`ed off own state schema: `diagnosis`, `userInstructions`. `generationFlags` input only.
const TranslationToEnglishOutputSchema =
  CaseTranslationToEnglishStateSchema.pick({
    diagnosis: true,
    userInstructions: true,
  });

export function buildCaseTranslationToEnglishGraph(
  runtime: GraphRuntime,
  traceNode: ReturnType<typeof createTraceNode>
) {
  return (
    new StateGraph(CaseTranslationToEnglishStateSchema, {
      context: RequestContextSchema,
      output: TranslationToEnglishOutputSchema,
    })
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

      // Plain edges, not `Send`: `Send` payload is JSON round-tripped, which corrupts `ContentPart` bytes.
      .addEdge(START, "translate_diagnosis")
      .addEdge(START, "translate_user_instructions")
      .addEdge("translate_diagnosis", END)
      .addEdge("translate_user_instructions", END)
      .compile()
  );
}
