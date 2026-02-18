import { END, START, StateGraph } from "@langchain/langgraph";
import {
  GlobalStateSchema,
  GraphInputSchema,
  type GlobalState,
} from "./state.js";
import { draftGraph } from "./01-draft/index.js";
import { councilGraph } from "./02-council/index.js";
import { consistencyGraph } from "./03-consistency/index.js";
import type { Case } from "@/domain-models/Case.js";
import type { GenerationFlag } from "@/domain-models/GenerationFlags.js";

import { GenerationError } from "@/errors/AppError.js";
import {
  AnamnesisCategoryDefaults,
  type AnamnesisCategory,
} from "@/domain-models/Anamnesis.js";
import type { Diagnosis } from "@/domain-models/Diagnosis.js";

type DecreaseLoopIterationOutput = Pick<GlobalState, "loopIterationsRemaining">;
/**
 * Decreases the remaining loop iterations by one.
 */
export function decreaseConsistencyIteration(
  state: GlobalState
): DecreaseLoopIterationOutput {
  console.debug(
    `[CaseGenerator: DecreaseLoopIteration] Remaining iterations after decrement: ${state.loopIterationsRemaining - 1}`
  );

  return {
    loopIterationsRemaining: state.loopIterationsRemaining - 1,
  };
}

export function checkRemainingLoopIterations(
  state: GlobalState
): "continue" | "end" {
  console.debug(
    `[CaseGenerator: CheckRemainingLoopIterations] Remaining iterations: ${state.loopIterationsRemaining}`
  );

  return state.loopIterationsRemaining <= 0 ? "end" : "continue";
}

export function checkConsistency(state: GlobalState): "refine" | "end" {
  console.debug(
    `[Consistency: CheckConsistency] Inconsistencies found: ${state.inconsistencies.length}`
  );

  return state.inconsistencies.length === 0 ? "end" : "refine";
}

/**
 * Build and compile the Council-Consistency-Refinement graph
 */
export function buildCaseDraftCouncilGraph() {
  // Create the state graph with our annotation schema
  const graph = new StateGraph(GlobalStateSchema, {
    input: GraphInputSchema,
  })
    .addNode("draft_phase", draftGraph)
    .addEdge(START, "draft_phase")

    .addNode("council_phase", councilGraph)
    .addEdge("draft_phase", "council_phase")
    .addNode("iteration_decrease", decreaseConsistencyIteration)
    .addEdge("council_phase", "iteration_decrease")
    .addNode("consistency_phase", consistencyGraph)
    .addConditionalEdges("iteration_decrease", checkRemainingLoopIterations, {
      continue: "consistency_phase",
      end: END,
    })
    .addNode("draft_reset", () => {
      // Reset drafts for new generation cycle
      return {
        drafts: [],
      };
    })
    // Conditionally route back to start if inconsistencies found
    .addConditionalEdges("consistency_phase", checkConsistency, {
      refine: "draft_reset",
      end: END,
    })
    .addEdge("draft_reset", "draft_phase");
  const compiledGraph = graph.compile();

  console.log("[GraphBuilder] Case draft council graph compiled");

  return compiledGraph;
}

/**
 * Execute the case generator graph
 */
export async function generateCase(
  diagnosis: Diagnosis,
  generationFlags: GenerationFlag[],
  context?: string,
  anamnesisCategories?: AnamnesisCategory[]
): Promise<Case> {
  const graph = buildCaseDraftCouncilGraph();

  anamnesisCategories = anamnesisCategories ?? AnamnesisCategoryDefaults;

  console.log(
    `[CaseGenerator] Starting case generation for:\n`,
    JSON.stringify(
      {
        diagnosis,
        context,
        generationFlags,
        anamnesisCategories,
      },
      null,
      2
    )
  );

  const result = await graph.invoke({
    diagnosis: diagnosis,
    generationFlags: generationFlags,
    context: context,
    anamnesisCategories: anamnesisCategories,
  });

  console.log("[CaseGenerator] Generation complete", result);

  if (!result.case) {
    throw new GenerationError("Case generation failed: No case generated");
  }

  return result.case;
}
