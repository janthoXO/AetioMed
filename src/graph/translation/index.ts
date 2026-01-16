import { START, StateGraph, END } from "@langchain/langgraph";
import { GlobalStateSchema } from "./state.js";
import { translateValues, translateAnamnesisCategory } from "./nodes.js";
import type { Case } from "@/domain-models/Case.js";
import type { Language } from "@/domain-models/Language.js";

/**
 * Graph to translate a generated case
 */
export function buildTranslationGraph() {
  const graph = new StateGraph(GlobalStateSchema)
    .addNode("translate_anamnesis_category", translateAnamnesisCategory)
    .addEdge(START, "translate_anamnesis_category")
    .addNode("translate_values", translateValues)
    .addEdge("translate_anamnesis_category", "translate_values")
    .addEdge("translate_values", END);

  return graph.compile();
}

export async function translateCase(caseToTranslate: Case, language: Language) {
  if (language === "English") {
    return caseToTranslate;
  }

  const graph = buildTranslationGraph();

  const result = await graph.invoke({
    case: caseToTranslate,
    language: language,
  });

  return result.case;
}
