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

// Deliberately NOT numbered under `02graphs/` (issue #159): unlike
// `01case-translation-to-english/` and `03case-translation-from-english/`,
// this pair does not run as a phase of the case generation pipeline at all
// — it runs between the plan graph and the case graph, translating plan
// mode's case outline for display to a human reviewer (out) and their
// edited segments back to English (in). A number here would claim a
// pipeline position that does not exist.

const TASK_DESCRIPTION =
  "These are sections of a clinical case outline shown to a human reviewer " +
  "in a medical training simulator. Translate faithfully: preserve markdown " +
  "formatting, numbers, units and drug names exactly; a heading starting " +
  "with '#' must keep its '#' prefix in the translation.";

function requiredLanguage(): string {
  // Same read path as `01case-translation-to-english/index.ts`'s
  // `requiredTargetLanguage` (issue #159): language is a property of the
  // bound ports, read off ALS, never off graph state.
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

/**
 * Two thin single-node graphs (issue #159), compiled separately by
 * `direction` — plan mode saves a checkpoint between the plan graph, this
 * graph and the case graph, which is why translate-out and translate-in are
 * each their own compiled graph rather than two nodes in one: the job
 * service needs a checkpoint boundary right where the human reviewer edits
 * the outline.
 */
export function buildOutlineTranslationGraph(
  runtime: GraphRuntime,
  traceNode: ReturnType<typeof createTraceNode>,
  direction: "out" | "in"
) {
  const builder = new StateGraph(OutlineTranslationStateSchema, {
    context: RequestContextSchema,
    output: OutlineTranslationOutputSchema,
  });

  if (direction === "out") {
    return builder
      .addNode(
        "translate_outline_out",
        traceNode(
          "translate_outline_out",
          makeTranslateOutline(runtime, "out"),
          "Translating case outline"
        )
      )
      .addEdge(START, "translate_outline_out")
      .addEdge("translate_outline_out", END)
      .compile();
  }

  return builder
    .addNode(
      "translate_review_in",
      traceNode(
        "translate_review_in",
        makeTranslateOutline(runtime, "in"),
        "Translating reviewed outline to English"
      )
    )
    .addEdge(START, "translate_review_in")
    .addEdge("translate_review_in", END)
    .compile();
}

/** `generateCase`'s pattern (`caseGraph.ts`) — invoke and unwrap. */
export async function translateOutlineValues(
  graph: ReturnType<typeof buildOutlineTranslationGraph>,
  values: Record<string, string>,
  opts?: { signal?: AbortSignal }
): Promise<Record<string, string>> {
  const result = await graph.invoke(
    { values },
    opts?.signal !== undefined ? { signal: opts.signal } : undefined
  );
  return result.translations;
}
