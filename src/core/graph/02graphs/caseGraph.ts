import { START, StateGraph, END } from "@langchain/langgraph";
import type { Case } from "../models/Case.js";
import { getRequestContext, RequestContextSchema } from "../utils/context.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import type { GenerationFlag } from "../models/GenerationFlags.js";
import type { UserInstructions } from "../models/UserInstructions.js";
import { buildCaseGenerationGraph } from "./02case-generation/index.js";
import { CaseGenerationStateSchema } from "./02case-generation/state.js";
import { buildCaseTranslationFromEnglishGraph } from "./03case-translation-from-english/index.js";
import { LanguageSchema, type Language } from "../models/Language.js";
import type { Difficulty } from "../models/Difficulty.js";
import { GenerationError } from "../errors/AppError.js";
import { buildCaseTranslationToEnglishGraph } from "./01case-translation-to-english/index.js";
import { createTraceNode } from "../utils/nodeWrapper.js";
import type { GraphRuntime } from "../runtime.js";
import type { Config } from "../config.js";
import type { EventBus } from "../../event-bus.js";
import type { Repos } from "../repos.js";

const CaseStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  generationFlags: true,
  difficulty: true,
  case: true,
}).extend({
  language: LanguageSchema.default("English"),
});

/**
 * Builds the compiled top-level case graph plus the bound `generateCase`
 * entry point, closed over `runtime`. Called once from the composition root
 * (`app.ts`) — and once per invocation from `exportGraphs.ts`, with a
 * minimal in-memory runtime, purely to render the topology.
 */
export function buildCaseGraph(
  runtime: GraphRuntime,
  bus: EventBus,
  config: Config,
  repos: Pick<Repos, "symptoms" | "anamnesis" | "procedures">
) {
  const traceNode = createTraceNode(bus);

  // Compiled once, not per-request.
  const caseGraph = new StateGraph(CaseStateSchema, RequestContextSchema)
    .addNode(
      "translation_to_english_phase",
      buildCaseTranslationToEnglishGraph(runtime, traceNode)
    )
    .addNode(
      "generation_phase",
      buildCaseGenerationGraph(runtime, config, repos.symptoms, traceNode)
    )
    .addNode(
      "translation_from_english_phase",
      buildCaseTranslationFromEnglishGraph(
        runtime,
        { anamnesis: repos.anamnesis, procedures: repos.procedures },
        traceNode
      )
    )

    .addConditionalEdges(
      START,
      (state) =>
        state.language && state.language !== "English" ? "translate" : "skip",
      {
        translate: "translation_to_english_phase",
        skip: "generation_phase",
      }
    )
    .addEdge("translation_to_english_phase", "generation_phase")
    .addConditionalEdges(
      "generation_phase",
      (state) =>
        state.language && state.language !== "English" ? "translate" : "skip",
      {
        translate: "translation_from_english_phase",
        skip: END,
      }
    )
    .addEdge("translation_from_english_phase", END)
    .compile();

  /**
   * Execute the case generator graph.
   */
  async function generateCase(
    diagnosis: Diagnosis,
    generationFlags: GenerationFlag[],
    userInstructions?: UserInstructions,
    language?: Language,
    difficulty?: Difficulty
  ): Promise<Case> {
    console.log(
      `[CaseGraph] Starting case generation for:\n`,
      JSON.stringify(
        { diagnosis, userInstructions, generationFlags, difficulty },
        null,
        2
      )
    );

    const context = getRequestContext();

    const result = await caseGraph.invoke(
      {
        diagnosis,
        generationFlags,
        userInstructions,
        language,
        difficulty,
      },
      {
        context: {
          llmConfig: context?.llmConfig,
          jobId: context?.jobId,
        },
        ...(context?.signal !== undefined ? { signal: context.signal } : {}),
      }
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

  return { caseGraph, generateCase };
}
