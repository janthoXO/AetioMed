import { START, StateGraph, END } from "@langchain/langgraph";
import type { Case } from "@/core/models/Case.js";
import {
  getRequiredRequestContext,
  RequestContextSchema,
} from "@/core/utils/context.js";
import type { Diagnosis } from "@/core/models/Diagnosis.js";
import type { GenerationFlag } from "@/core/models/GenerationFlags.js";
import type { UserInstructions } from "@/core/models/UserInstructions.js";
import {
  AnamnesisCategoryDefaults,
  type AnamnesisCategory,
} from "@/core/models/Anamnesis.js";
import { caseGenerationGraph } from "./case-generation/index.js";
import { CaseGenerationStateSchema } from "./case-generation/state.js";
import { caseTranslationGraph } from "./case-translation/index.js";
import { LanguageSchema, type Language } from "@/core/models/Language.js";
import { GenerationError } from "@/core/errors/AppError.js";

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

  const { llmConfig, traceId } = getRequiredRequestContext();

  const result = await buildCaseGraph().invoke(
    {
      diagnosis: diagnosis,
      generationFlags: generationFlags,
      userInstructions: userInstructions,
      anamnesisCategories: anamnesisCategories,
      language: language,
    },
    { context: { llmConfig, traceId } }
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
