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
import { caseGenerationGraph } from "./case-generation/index.js";
import { CaseGenerationStateSchema } from "./case-generation/state.js";
import { caseTranslationGraph } from "./case-translation/index.js";
import { LanguageSchema, type Language } from "../models/Language.js";
import { GenerationError } from "../errors/AppError.js";

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
    .addNode("generation_phase", caseGenerationGraph)
    .addNode("translation_phase", caseTranslationGraph)

    .addEdge(START, "generation_phase")
    .addConditionalEdges("generation_phase", (state) => {
      if (state.language && state.language !== "English") {
        return "translation_phase";
      }

      return END;
    })
    .addEdge("translation_phase", END);

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
