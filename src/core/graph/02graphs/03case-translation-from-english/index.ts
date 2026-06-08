import { START, StateGraph, END } from "@langchain/langgraph";
import { CaseTranslationFromEnglishStateSchema } from "./state.js";
import { RequestContextSchema } from "@/core/graph/utils/context.js";
import { type CaseTranslationFromEnglishState } from "./state.js";
import { type Runtime, Send } from "@langchain/langgraph";
import type { RequestContext } from "@/core/graph/utils/context.js";
import type { PickNested } from "@/core/graph/utils/pickNested.js";
import { translationFromEnglishTools } from "./tools.js";
import { wrapNode } from "@/core/graph/utils/nodeWrapper.js";

async function translateAnamnesisCategory(
  state: CaseTranslationFromEnglishState
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
    await translationFromEnglishTools.translateAnamnesisCategoriesFromEnglish.invoke(
      {
        categories: state.case.anamnesis.map((a) => a.category),
        language: state.language,
      }
    );

  const updatedAnamnesis = state.case.anamnesis.map((a) => ({
    ...a,
    category: categoryTranslations[a.category]!,
  }));

  return { case: { anamnesis: updatedAnamnesis } };
}

async function translateProcedureNames(
  state: CaseTranslationFromEnglishState
): Promise<
  PickNested<CaseTranslationFromEnglishState, "case", "procedures"> | undefined
> {
  console.debug("[Translation] Translating procedure names to", state.language);

  if (!state.case.procedures?.length) {
    console.debug("[Translation] No procedures to translate.");
    return undefined;
  }

  const translations =
    await translationFromEnglishTools.translateProcedureNamesFromEnglish.invoke(
      {
        procedureNames: state.case.procedures.map((p) => p.name),
        language: state.language,
      }
    );

  const updatedProcedures = state.case.procedures.map((p) => ({
    ...p,
    name: translations[p.name] ?? p.name,
  }));

  return { case: { procedures: updatedProcedures } };
}

async function translateValues(
  state: CaseTranslationFromEnglishState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<CaseTranslationFromEnglishState, "case">> {
  console.debug("[Translation] Translating case values to", state.language);

  const translatedCase = await translationFromEnglishTools.translateCase.invoke(
    {
      case: state.case,
      language: state.language,
      generationFlags: state.generationFlags,
    },
    runtime?.context
  );
  return { case: translatedCase };
}

export const caseTranslationFromEnglishGraph = new StateGraph(
  CaseTranslationFromEnglishStateSchema,
  RequestContextSchema
)
  .addNode(
    "translate_anamnesis_category",
    wrapNode("translate_anamnesis_category", translateAnamnesisCategory)
  )
  .addNode(
    "translate_procedures_names",
    wrapNode("translate_procedures_names", translateProcedureNames)
  )
  .addNode("translate_values", wrapNode("translate_values", translateValues))

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
