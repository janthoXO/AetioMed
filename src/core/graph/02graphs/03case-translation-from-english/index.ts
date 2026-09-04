import { START, StateGraph, END } from "@langchain/langgraph";
import { CaseTranslationFromEnglishStateSchema } from "./state.js";
import { RequestContextSchema } from "@/core/graph/utils/context.js";
import { type CaseTranslationFromEnglishState } from "./state.js";
import { type Runtime, Send } from "@langchain/langgraph";
import type { RequestContext } from "@/core/graph/utils/context.js";
import type { PickNested } from "@/core/graph/utils/pickNested.js";
import { createTranslationFromEnglishTools } from "./tools.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { AnamnesisRepo } from "@/core/graph/03repo/anamnesis.repo.js";
import type { ProceduresRepo } from "@/core/graph/03repo/procedures.repo.js";

function makeTranslateAnamnesisCategory(
  runtime: GraphRuntime,
  tools: ReturnType<typeof createTranslationFromEnglishTools>
) {
  return async function translateAnamnesisCategory(
    state: CaseTranslationFromEnglishState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<
    PickNested<CaseTranslationFromEnglishState, "case", "anamnesis"> | undefined
  > {
    console.debug(
      "[Translation] Translating anamnesis categories to",
      state.language
    );

    if (!state.case.anamnesis?.length) {
      console.debug("[Translation] No anamnesis categories to translate.");
      return undefined;
    }

    const categoryTranslations =
      await tools.translateAnamnesisCategoriesFromEnglish.invoke(
        {
          categories: state.case.anamnesis.map((a) => a.category),
          language: state.language,
        },
        runtime,
        lgRuntime?.context
      );

    const updatedAnamnesis = state.case.anamnesis.map((a) => ({
      ...a,
      category: categoryTranslations[a.category]!,
    }));

    return { case: { anamnesis: updatedAnamnesis } };
  };
}

function makeTranslateProcedureNames(
  runtime: GraphRuntime,
  tools: ReturnType<typeof createTranslationFromEnglishTools>
) {
  return async function translateProcedureNames(
    state: CaseTranslationFromEnglishState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<
    | PickNested<CaseTranslationFromEnglishState, "case", "procedures">
    | undefined
  > {
    console.debug(
      "[Translation] Translating procedure names to",
      state.language
    );

    if (!state.case.procedures?.length) {
      console.debug("[Translation] No procedures to translate.");
      return undefined;
    }

    const translations = await tools.translateProcedureNamesFromEnglish.invoke(
      {
        procedureNames: state.case.procedures.map((p) => p.name),
        language: state.language,
      },
      runtime,
      lgRuntime?.context
    );

    const updatedProcedures = state.case.procedures.map((p) => ({
      ...p,
      name: translations[p.name] ?? p.name,
    }));

    return { case: { procedures: updatedProcedures } };
  };
}

function makeTranslateValues(
  runtime: GraphRuntime,
  tools: ReturnType<typeof createTranslationFromEnglishTools>
) {
  return async function translateValues(
    state: CaseTranslationFromEnglishState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<CaseTranslationFromEnglishState, "case">> {
    console.debug("[Translation] Translating case values to", state.language);

    const translatedCase = await tools.translateCase.invoke(
      {
        case: state.case,
        language: state.language,
        generationFlags: state.generationFlags,
      },
      runtime,
      lgRuntime?.context
    );
    return { case: translatedCase };
  };
}

export function buildCaseTranslationFromEnglishGraph(
  runtime: GraphRuntime,
  repos: { anamnesis: AnamnesisRepo; procedures: ProceduresRepo },
  traceNode: ReturnType<typeof createTraceNode>
) {
  const tools = createTranslationFromEnglishTools(repos);

  return new StateGraph(
    CaseTranslationFromEnglishStateSchema,
    RequestContextSchema
  )
    .addNode(
      "translate_anamnesis_category",
      traceNode(
        "translate_anamnesis_category",
        makeTranslateAnamnesisCategory(runtime, tools),
        "Translating anamnesis categories"
      )
    )
    .addNode(
      "translate_procedures_names",
      traceNode(
        "translate_procedures_names",
        makeTranslateProcedureNames(runtime, tools),
        "Translating procedure names"
      )
    )
    .addNode(
      "translate_values",
      traceNode(
        "translate_values",
        makeTranslateValues(runtime, tools),
        "Translating case to target language"
      )
    )

    .addConditionalEdges(START, (state): Send[] => {
      const sends: Send[] = [];
      if (state.case.anamnesis?.length) {
        sends.push(new Send("translate_anamnesis_category", state));
      }
      if (state.case.procedures?.length) {
        sends.push(new Send("translate_procedures_names", state));
      }
      if (sends.length === 0) {
        sends.push(new Send("translate_values", state));
      }
      return sends;
    })
    .addEdge("translate_anamnesis_category", "translate_values")
    .addEdge("translate_procedures_names", "translate_values")
    .addEdge("translate_values", END)
    .compile();
}
