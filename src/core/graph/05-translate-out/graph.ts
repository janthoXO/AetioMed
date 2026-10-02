import { START, StateGraph, END } from "@langchain/langgraph";
import { CaseTranslationFromEnglishStateSchema } from "./state.js";
import {
  RequestContextSchema,
  getRequestContext,
} from "@/core/graph/utils/context.js";
import { type CaseTranslationFromEnglishState } from "./state.js";
import { type Runtime } from "@langchain/langgraph";
import type { RequestContext } from "@/core/graph/utils/context.js";
import {
  caseTextMap,
  applyCaseTextTranslations,
  translateProcedureTree,
} from "./caseText.js";
import {
  translateAnamnesisCategoriesFromEnglish,
  translateProcedureNodesFromEnglish,
  translateRestValues,
} from "./gateway.js";
import type { DefinedTranslations } from "./state.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { Case } from "@/core/graph/shared/domain/Case.js";
import {
  nodeKey,
  nodePaths,
} from "@/core/graph/shared/domain/ProcedureTree.js";
import { GenerationError } from "@/core/graph/errors/AppError.js";

/** Read off ALS, not graph state. Phase only entered when a non-English language is bound; absent = bug. */
function requiredTargetLanguage(): string {
  const language = getRequestContext()?.language;
  if (!language) {
    throw new GenerationError(
      "translate-from-english reached without a language bound on the request context"
    );
  }
  return language;
}

/** "Defined" pass: catalog dictionary lookups (per-key locked LLM fill on miss) for `procedures[].name` and `anamnesis[].category`. Writes ONLY `definedTranslations`, never `case`. */
function makeTranslateDefined(runtime: GraphRuntime) {
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
    const procedureNodes = state.case.procedures
      ? nodePaths(state.case.procedures).map((path) => ({
          key: nodeKey(path),
          name: path[path.length - 1]!,
        }))
      : [];

    const [anamnesisCategories, procedureNodeTranslations] = await Promise.all([
      categories.length
        ? translateAnamnesisCategoriesFromEnglish(
            runtime,
            { categories, language },
            lgRuntime?.context
          )
        : Promise.resolve({}),
      procedureNodes.length
        ? translateProcedureNodesFromEnglish(
            runtime,
            { procedureNodes, language },
            lgRuntime?.context
          )
        : Promise.resolve({}),
    ]);

    const definedTranslations: DefinedTranslations = {
      anamnesisCategories,
      procedureNodes: procedureNodeTranslations,
    };

    return { definedTranslations };
  };
}

/** "Rest" pass: one LLM call over every `ContentPart` text fragment (`alt`, plus decoded prose for text parts), keyed by stable path (`caseTextMap`). Writes ONLY `restTranslations`. Never sees `value` bytes, procedure names, categories. */
function makeTranslateRest(runtime: GraphRuntime) {
  return async function translateRest(
    state: CaseTranslationFromEnglishState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<CaseTranslationFromEnglishState, "restTranslations">> {
    const language = requiredTargetLanguage();
    const values = caseTextMap(state.case);
    console.debug(
      `[Translation] Translating ${Object.keys(values).length} free-text fragment(s) to`,
      language
    );

    const restTranslations = await translateRestValues(
      runtime,
      { values, language },
      lgRuntime?.context
    );

    return { restTranslations };
  };
}

/** Only node writing `case`. Pure function of both channels plus original case; pass completion order irrelevant. Exported for tests. */
export function translateMerge(
  state: CaseTranslationFromEnglishState
): Pick<CaseTranslationFromEnglishState, "case"> {
  const { anamnesisCategories, procedureNodes } = state.definedTranslations;
  const altFields = applyCaseTextTranslations(
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
      procedures: translateProcedureTree(
        state.case.procedures,
        procedureNodes,
        state.restTranslations
      ),
    }),
  };

  return { case: mergedCase };
}

// Mounted as `translate_out_phase`. `.pick()` off own state schema: `case` only. `definedTranslations`/`restTranslations` are internal scratch, never written back.
const TranslationFromEnglishOutputSchema =
  CaseTranslationFromEnglishStateSchema.pick({ case: true });

export function buildCaseTranslationFromEnglishGraph(
  runtime: GraphRuntime,
  traceNode: ReturnType<typeof createTraceNode>
) {
  return (
    new StateGraph(CaseTranslationFromEnglishStateSchema, {
      context: RequestContextSchema,
      output: TranslationFromEnglishOutputSchema,
    })
      .addNode(
        "translate_defined",
        traceNode(
          "translate_defined",
          makeTranslateDefined(runtime),
          "Translating procedure names and anamnesis categories"
        )
      )
      .addNode(
        "translate_rest",
        traceNode(
          "translate_rest",
          makeTranslateRest(runtime),
          "Translating case text to target language"
        )
      )
      .addNode(
        "translate_merge",
        traceNode("translate_merge", translateMerge, "Merging translated case")
      )

      // Both passes fire unconditionally in parallel from START, no ordering. Each no-ops when nothing to translate,
      // so `translate_merge`'s input channels are always populated.
      //
      // Plain edges, not `Send`: `Send` JSON round-trips payload, corrupting `ContentPart.value` bytes.
      // A `Send` payload must never carry `ContentPart` bytes (see `buildFieldGenerationSends`, text-only).
      .addEdge(START, "translate_defined")
      .addEdge(START, "translate_rest")
      .addEdge("translate_defined", "translate_merge")
      .addEdge("translate_rest", "translate_merge")
      .addEdge("translate_merge", END)
      .compile()
  );
}
