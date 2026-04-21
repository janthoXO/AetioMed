import { START, StateGraph, END } from "@langchain/langgraph";
import type { Case } from "../models/Case.js";
import { getRequestContext, RequestContextSchema } from "../utils/context.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import type { GenerationFlag } from "../models/GenerationFlags.js";
import type { UserInstructions } from "../models/UserInstructions.js";
import {
  AnamnesisCategoryDefaults,
  type AnamnesisCategory,
} from "../models/Anamnesis.js";
import { caseGenerationGraph } from "./02case-generation/index.js";
import { CaseGenerationStateSchema } from "./02case-generation/state.js";
import { caseTranslationFromEnglishGraph } from "./03case-translation-from-english/index.js";
import { LanguageSchema, type Language } from "../models/Language.js";
import { GenerationError } from "../errors/AppError.js";
import { caseTranslationToEnglishGraph } from "./01case-translation-to-english/index.js";

const CaseStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  generationFlags: true,
  anamnesisCategories: true,
  case: true,
}).extend({
  language: LanguageSchema.default("English"),
});

/**
 * Graph to translate a generated case
 */
export function buildCaseGraph() {
  const graph = new StateGraph(CaseStateSchema, RequestContextSchema)

    .addNode("translation_to_english_phase", caseTranslationToEnglishGraph)
    .addNode("generation_phase", caseGenerationGraph)
    .addNode("translation_from_english_phase", caseTranslationFromEnglishGraph)

    .addConditionalEdges(
      START,
      (state) => {
        if (state.language && state.language !== "English") {
          return "translate";
        }

        return "skip";
      },
      {
        translate: "translation_to_english_phase",
        skip: "generation_phase",
      }
    )
    .addEdge("translation_to_english_phase", "generation_phase")
    .addConditionalEdges(
      "generation_phase",
      (state) => {
        if (state.language && state.language !== "English") {
          return "translate";
        }

        return "skip";
      },
      {
        translate: "translation_from_english_phase",
        skip: END,
      }
    )
    .addEdge("translation_from_english_phase", END);

  return graph.compile();
}

/**
 * Execute the case generator graph
 */
export async function generateCase(
  diagnosis: Diagnosis,
  generationFlags: GenerationFlag[],
  userInstructions?: UserInstructions,
  language?: Language,
  anamnesisCategories?: AnamnesisCategory[]
): Promise<Case> {
  anamnesisCategories = anamnesisCategories ?? AnamnesisCategoryDefaults;

  console.log(
    `[CaseGraph] Starting case generation for:\n`,
    JSON.stringify(
      {
        diagnosis,
        userInstructions,
        generationFlags,
        anamnesisCategories,
      },
      null,
      2
    )
  );

  const context = getRequestContext();

  const result = await buildCaseGraph().invoke(
    {
      diagnosis: diagnosis,
      generationFlags: generationFlags,
      userInstructions: userInstructions,
      anamnesisCategories: anamnesisCategories,
      language: language,
    },
    { context: { llmConfig: context?.llmConfig, traceId: context?.traceId } }
  );

  console.log(
    "[CaseGraph] Generation complete",
    JSON.stringify(result, null, 2)
  );

  if (!result.case) {
    throw new GenerationError("Case generation failed: No case generated");
  }

  return result.case;
}
