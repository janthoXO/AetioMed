import { START, StateGraph, END } from "@langchain/langgraph";
import {
  OutlineTranslationStateSchema,
  type OutlineTranslationState,
} from "./state.js";
import {
  RequestContextSchema,
  getRequestContext,
} from "@/core/graph/utils/context.js";
import { translateRecordKeyed } from "@/core/graph/03aigateway/translate.helper.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import { GenerationError } from "@/core/graph/errors/AppError.js";

// Not numbered under `02graphs/`: runs between plan graph and case graph, not as a pipeline phase.
// Translates plan-mode outline out for display and edited segments back to English.

const TASK_DESCRIPTION =
  "These are sections of a clinical case outline shown to a human reviewer " +
  "in a medical training simulator. Translate faithfully: preserve markdown " +
  "formatting, numbers, units and drug names exactly; a heading starting " +
  "with '#' must keep its '#' prefix in the translation.";

function requiredLanguage(): string {
  // Same as `01case-translation-to-english/index.ts`'s `requiredTargetLanguage`: language read off ALS, not graph state.
  const language = getRequestContext()?.language;
  if (!language) {
    throw new GenerationError(
      "outline translation reached without a language bound on the request context"
    );
  }
  return language;
}

/** Segments that are empty/whitespace-only translate to themselves — no LLM call. */
function partitionValues(values: Record<string, string>): {
  nonEmpty: Record<string, string>;
  identity: Record<string, string>;
} {
  const nonEmpty: Record<string, string> = {};
  const identity: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value.trim() === "") {
      identity[key] = value;
    } else {
      nonEmpty[key] = value;
    }
  }
  return { nonEmpty, identity };
}

function makeTranslateOutline(runtime: GraphRuntime, direction: "out" | "in") {
  return async function translateOutline(
    state: OutlineTranslationState
  ): Promise<Pick<OutlineTranslationState, "translations">> {
    const language = requiredLanguage();
    const { nonEmpty, identity } = partitionValues(state.values);

    if (Object.keys(nonEmpty).length === 0) {
      return { translations: identity };
    }

    const sourceLanguage = direction === "out" ? "English" : language;
    const targetLanguage = direction === "out" ? language : "English";

    const translated = await translateRecordKeyed(runtime, {
      logTag: direction === "out" ? "TranslateOutlineOut" : "TranslateReviewIn",
      taskDescription: TASK_DESCRIPTION,
      contextLines: [
        `Source language: ${sourceLanguage}`,
        `Target language: ${targetLanguage}`,
      ],
      values: nonEmpty,
      context: getRequestContext(),
    });

    return { translations: { ...identity, ...translated } };
  };
}

const OutlineTranslationOutputSchema = OutlineTranslationStateSchema.pick({
  translations: true,
});

/** Two thin single-node graphs, compiled separately by `direction`: translate-out and translate-in never run in the same call. */
export function buildOutlineTranslationGraph(
  runtime: GraphRuntime,
  traceNode: ReturnType<typeof createTraceNode>,
  direction: "out" | "in"
) {
  const [node, label] =
    direction === "out"
      ? (["translate_outline_out", "Translating case outline"] as const)
      : ([
          "translate_review_in",
          "Translating reviewed outline to English",
        ] as const);

  return new StateGraph(OutlineTranslationStateSchema, {
    context: RequestContextSchema,
    output: OutlineTranslationOutputSchema,
  })
    .addNode(
      node,
      traceNode(node, makeTranslateOutline(runtime, direction), label)
    )
    .addEdge(START, node)
    .addEdge(node, END)
    .compile();
}

/**
 * Invoke and unwrap, for the request bound on ALS — the same invoke options
 * `caseGraph.ts`'s `planCase`/`renderCase` pass, so labels carry the job id
 * and a per-request LLM config and abort signal reach the translator.
 */
export async function translateOutlineValues(
  graph: ReturnType<typeof buildOutlineTranslationGraph>,
  values: Record<string, string>
): Promise<Record<string, string>> {
  const context = getRequestContext();
  const result = await graph.invoke(
    { values },
    {
      context: { llmConfig: context?.llmConfig, jobId: context?.jobId },
      ...(context?.signal !== undefined ? { signal: context.signal } : {}),
    }
  );
  return result.translations;
}
