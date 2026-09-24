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
  createTranslationFromEnglishTools,
  caseTextMap,
  applyCaseTextTranslations,
} from "./tools.js";
import type { DefinedTranslations } from "./state.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { AnamnesisRepo } from "@/core/graph/catalog/anamnesis/index.js";
import type { ProceduresRepo } from "@/core/graph/catalog/procedures/index.js";
import type { Case } from "@/core/graph/models/Case.js";
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

/** "Rest" pass: one LLM call over every `ContentPart` text fragment (`alt`, plus decoded prose for text parts), keyed by stable path (`caseTextMap`). Writes ONLY `restTranslations`. Never sees `value` bytes, procedure names, categories. */
function makeTranslateRest(
  runtime: GraphRuntime,
  tools: ReturnType<typeof createTranslationFromEnglishTools>
) {
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

    const restTranslations = await tools.translateRestValues.invoke(
      { values, language },
      runtime,
      lgRuntime?.context
    );

    return { restTranslations };
  };
}

/** Only node writing `case`. Pure function of both channels plus original case; pass completion order irrelevant. Exported for tests. */
export function translateMerge(
  state: CaseTranslationFromEnglishState
): Pick<CaseTranslationFromEnglishState, "case"> {
  const { anamnesisCategories, procedureNames } = state.definedTranslations;
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
      procedures: state.case.procedures.map((p, i) => ({
        ...altFields.procedures![i]!,
        name: procedureNames[p.name] ?? p.name,
      })),
    }),
  };

  return { case: mergedCase };
}

// Mounted as `translation_from_english_phase`. `.pick()` off own state schema: `case` only. `definedTranslations`/`restTranslations` are internal scratch, never written back.
const TranslationFromEnglishOutputSchema =
  CaseTranslationFromEnglishStateSchema.pick({ case: true });

export function buildCaseTranslationFromEnglishGraph(
  runtime: GraphRuntime,
  repos: { anamnesis: AnamnesisRepo; procedures: ProceduresRepo },
  traceNode: ReturnType<typeof createTraceNode>
) {
  const tools = createTranslationFromEnglishTools(repos);

  return (
    new StateGraph(CaseTranslationFromEnglishStateSchema, {
      context: RequestContextSchema,
      output: TranslationFromEnglishOutputSchema,
    })
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
