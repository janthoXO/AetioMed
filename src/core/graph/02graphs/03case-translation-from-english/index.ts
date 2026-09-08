import { START, StateGraph, END } from "@langchain/langgraph";
import { CaseTranslationFromEnglishStateSchema } from "./state.js";
import {
  RequestContextSchema,
  getRequestContext,
} from "@/core/graph/utils/context.js";
import { type CaseTranslationFromEnglishState } from "./state.js";
import { type Runtime, Send } from "@langchain/langgraph";
import type { RequestContext } from "@/core/graph/utils/context.js";
import {
  createTranslationFromEnglishTools,
  caseAltMap,
  applyCaseAltTranslations,
} from "./tools.js";
import type { DefinedTranslations } from "./state.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { AnamnesisRepo } from "@/core/graph/catalog/anamnesis/index.js";
import type { ProceduresRepo } from "@/core/graph/catalog/procedures/index.js";
import type { Case } from "@/core/graph/models/Case.js";
import { GenerationError } from "@/core/graph/errors/AppError.js";

/**
 * Read off ALS, not graph state (issue 09 §2). This subgraph is only ever
 * entered when `requestNeedsTranslation` (`caseGraph.ts`) already found a
 * bound, non-English language, so an absent value here is a real bug, not a
 * legitimate "no language" case.
 */
function requiredTargetLanguage(): string {
  const language = getRequestContext()?.language;
  if (!language) {
    throw new GenerationError(
      "translate-from-english reached without a language bound on the request context"
    );
  }
  return language;
}

/**
 * Issue 12 §1's "Defined" pass: catalog dictionary lookups (per-key locked
 * LLM fill on a miss, issue 03) for `procedures[].name` and
 * `anamnesis[].category`. The two former nodes are merged into one — they
 * share a trigger, a language, and now a single output channel
 * (`definedTranslations`), so two nodes bought nothing once neither writes
 * `case` directly. Writes ONLY `definedTranslations` — never `case`.
 */
function makeTranslateDefined(
  runtime: GraphRuntime,
  tools: ReturnType<typeof createTranslationFromEnglishTools>
) {
  return async function translateDefined(
    state: CaseTranslationFromEnglishState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<CaseTranslationFromEnglishState, "definedTranslations">> {
    const language = requiredTargetLanguage();
    console.debug(
      "[Translation] Translating defined vocabulary (procedure names, anamnesis categories) to",
      language
    );

    const categories = state.case.anamnesis?.map((a) => a.category) ?? [];
    const procedureNames = state.case.procedures?.map((p) => p.name) ?? [];

    const [anamnesisCategories, procedureNameTranslations] = await Promise.all([
      categories.length
        ? tools.translateAnamnesisCategoriesFromEnglish.invoke(
            { categories, language },
            runtime,
            lgRuntime?.context
          )
        : Promise.resolve({}),
      procedureNames.length
        ? tools.translateProcedureNamesFromEnglish.invoke(
            { procedureNames, language },
            runtime,
            lgRuntime?.context
          )
        : Promise.resolve({}),
    ]);

    const definedTranslations: DefinedTranslations = {
      anamnesisCategories,
      procedureNames: procedureNameTranslations,
    };

    return { definedTranslations };
  };
}

/**
 * Issue 12 §1/§2's "Rest" pass: one LLM call over every `ContentPart.alt` in
 * the case, keyed by stable path (`tools.ts`'s `caseAltMap`). Writes ONLY
 * `restTranslations` — never `case`, and never sees `value` bytes, procedure
 * names, or anamnesis categories (those are the defined pass's job).
 */
function makeTranslateRest(
  runtime: GraphRuntime,
  tools: ReturnType<typeof createTranslationFromEnglishTools>
) {
  return async function translateRest(
    state: CaseTranslationFromEnglishState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<CaseTranslationFromEnglishState, "restTranslations">> {
    const language = requiredTargetLanguage();
    const values = caseAltMap(state.case);
    console.debug(
      `[Translation] Translating ${Object.keys(values).length} free-text fragment(s) to`,
      language
    );

    const restTranslations = await tools.translateRestValues.invoke(
      { values, language },
      runtime,
      lgRuntime?.context
    );

    return { restTranslations };
  };
}

/**
 * The only node that writes `case` (issue 12 §1). A pure function of the
 * two disjoint channels the passes above produced plus the original case —
 * there is no order between the two passes to be sensitive to, so reversing
 * their completion order is guaranteed, by construction, to produce an
 * identical merged case. Exported directly (not behind a factory, since it
 * needs no runtime/tools closure) so tests can call it with hand-built
 * `definedTranslations`/`restTranslations` in either order and assert the
 * outputs are identical.
 */
export function translateMerge(
  state: CaseTranslationFromEnglishState
): Pick<CaseTranslationFromEnglishState, "case"> {
  const { anamnesisCategories, procedureNames } = state.definedTranslations;
  const altFields = applyCaseAltTranslations(
    state.case,
    state.restTranslations
  );

  const mergedCase: Case = {
    ...state.case,
    ...altFields,
    ...(state.case.anamnesis && {
      anamnesis: state.case.anamnesis.map((a, i) => ({
        ...altFields.anamnesis![i]!,
        category: anamnesisCategories[a.category] ?? a.category,
      })),
    }),
    ...(state.case.procedures && {
      procedures: state.case.procedures.map((p, i) => ({
        ...altFields.procedures![i]!,
        name: procedureNames[p.name] ?? p.name,
      })),
    }),
  };

  return { case: mergedCase };
}

export function buildCaseTranslationFromEnglishGraph(
  runtime: GraphRuntime,
  repos: { anamnesis: AnamnesisRepo; procedures: ProceduresRepo },
  traceNode: ReturnType<typeof createTraceNode>
) {
  const tools = createTranslationFromEnglishTools(repos);

  return (
    new StateGraph(CaseTranslationFromEnglishStateSchema, RequestContextSchema)
      .addNode(
        "translate_defined",
        traceNode(
          "translate_defined",
          makeTranslateDefined(runtime, tools),
          "Translating procedure names and anamnesis categories"
        )
      )
      .addNode(
        "translate_rest",
        traceNode(
          "translate_rest",
          makeTranslateRest(runtime, tools),
          "Translating case text to target language"
        )
      )
      .addNode(
        "translate_merge",
        traceNode("translate_merge", translateMerge, "Merging translated case")
      )

      // Both passes fire unconditionally and in parallel from START — there is
      // no ordering between them to get wrong (issue 12 §1). Each is a no-op
      // internally when it finds nothing to translate (empty categories/
      // procedures/content-part map), rather than being skipped by an edge —
      // that keeps `translate_merge`'s two input channels always populated
      // (with their schema defaults) instead of conditionally absent.
      .addConditionalEdges(START, (state): Send[] => [
        new Send("translate_defined", state),
        new Send("translate_rest", state),
      ])
      .addEdge("translate_defined", "translate_merge")
      .addEdge("translate_rest", "translate_merge")
      .addEdge("translate_merge", END)
      .compile()
  );
}
