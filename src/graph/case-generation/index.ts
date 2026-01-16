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
import type { GenerationFlags } from "@/domain-models/GenerationFlags.js";

import { CaseGenerationError } from "@/errors/AppError.js";

export function checkConsistency(state: GlobalState): "refine" | "end" {
  console.debug(
    `[Consistency: CheckConsistency] Inconsistencies found: ${state.inconsistencies.length}, Remaining iterations: ${state.inconsistencyIterationsRemaining}`
  );

  return Object.keys(state.inconsistencies).length === 0 ||
    state.inconsistencyIterationsRemaining === 0
    ? "end"
    : "refine";
}

/**
 * Build and compile the Council-Consistency-Refinement graph
 */
export function buildCaseGeneratorGraph() {
  // Create the state graph with our annotation schema
  const graph = new StateGraph(GlobalStateSchema, {
    input: GraphInputSchema,
  })
    .addNode("draft_phase", draftGraph)
    .addEdge(START, "draft_phase")

    .addNode("council_phase", councilGraph)
    .addEdge("draft_phase", "council_phase")

    .addNode("consistency_reset", () => {
      // Reset inconsistencies for new consistency check
      return {
        inconsistencies: [],
      };
    })
    .addNode("consistency_phase", consistencyGraph)
    .addEdge("council_phase", "consistency_reset")
    .addEdge("consistency_reset", "consistency_phase")

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

  console.log("[GraphBuilder] Case generation graph compiled");

  return compiledGraph;
}

/**
 * Execute the case generator graph
 */
export async function generateCase(
  icdCode: string | undefined,
  diseaseName: string,
  generationFlags: GenerationFlags[],
  context?: string
): Promise<Case> {
  const graph = buildCaseGeneratorGraph();

  console.log(
    `[CaseGenerator] Starting case generation for:\n`,
    JSON.stringify(
      {
        icdCode,
        diseaseName,
        context,
        generationFlags,
      },
      null,
      2
    )
  );

  const result = await graph.invoke({
    icdCode: icdCode,
    diagnosis: diseaseName,
    generationFlags: generationFlags,
    context: context,
  });

  console.log("[CaseGenerator] Generation complete", result);

  if (!result.case) {
    throw new CaseGenerationError("Case generation failed: No case generated");
  }

  return result.case;
}
