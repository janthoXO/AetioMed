import { END, START, StateGraph } from "@langchain/langgraph";
import { GlobalStateSchema, GraphInputSchema } from "./state.js";
import type { Case } from "@/models/Case.js";
import type { GenerationFlag } from "@/models/GenerationFlags.js";

import { GenerationError } from "@/errors/AppError.js";
import {
  AnamnesisCategoryDefaults,
  type AnamnesisCategory,
} from "@/models/Anamnesis.js";
import type { Diagnosis } from "@/models/Diagnosis.js";
import { generationGraph } from "./02generation/index.js";
import { inconsistencyGraph } from "./03inconsistency/index.js";
import { symptomsGraph } from "./01symptom/index.js";

/**
 * Build and compile the Council-Consistency-Refinement graph
 */
export function buildCaseParallelGraph() {
  // Create the state graph with our annotation schema
  const graph = new StateGraph(GlobalStateSchema, {
    input: GraphInputSchema,
  })
    .addNode("symptom_phase", symptomsGraph)
    .addNode("generation_phase", generationGraph)
    .addNode("inconsistency_phase", inconsistencyGraph)

    .addEdge(START, "symptom_phase")
    .addEdge("symptom_phase", "generation_phase")
    .addEdge("generation_phase", "inconsistency_phase")
    .addEdge("inconsistency_phase", END);
  const compiledGraph = graph.compile();

  console.log("[GraphBuilder] Case Parallel graph compiled");

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
  const graph = buildCaseParallelGraph();

  anamnesisCategories = anamnesisCategories ?? AnamnesisCategoryDefaults;

  console.log(
    `[CaseParallelGraph] Starting case generation for:\n`,
    JSON.stringify(
      {
        diagnosis,
        userInstructions: context,
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
    userInstructions: context,
    anamnesisCategories: anamnesisCategories,
  });

  console.log(
    "[CaseParallelGraph] Generation complete",
    JSON.stringify(result, null, 2)
  );

  if (!result.case) {
    throw new GenerationError("Case generation failed: No case generated");
  }

  return result.case;
}
