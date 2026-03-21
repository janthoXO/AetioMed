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
import { symptomsGraph } from "./01symptom/index.js";
import { singleFieldGraph } from "./02singlefield/index.js";
import { multiFieldGraph } from "./02multifield/index.js";
import type { UserInstructions } from "@/models/UserInstructions.js";

/**
 * Build and compile the Council-Consistency-Refinement graph
 */
export function buildCaseGraph() {
  // Create the state graph with our annotation schema
  const graph = new StateGraph(GlobalStateSchema, {
    input: GraphInputSchema,
  })
    .addNode("symptom_phase", symptomsGraph)
    .addNode("single_field_phase", singleFieldGraph)
    .addNode("multi_field_phase", multiFieldGraph)

    .addEdge(START, "symptom_phase")
    .addConditionalEdges(
      "symptom_phase",
      (state) => {
        if (state.generationFlags.length === 1) {
          return "single";
        }

        return "multi";
      },
      {
        single: "single_field_phase",
        multi: "multi_field_phase",
      }
    )
    .addEdge("single_field_phase", END)
    .addEdge("multi_field_phase", END);
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
  userInstructions?: UserInstructions,
  anamnesisCategories?: AnamnesisCategory[]
): Promise<Case> {
  const graph = buildCaseGraph();

  anamnesisCategories = anamnesisCategories ?? AnamnesisCategoryDefaults;

  console.log(
    `[CaseParallelGraph] Starting case generation for:\n`,
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

  const result = await graph.invoke({
    diagnosis: diagnosis,
    generationFlags: generationFlags,
    userInstructions: userInstructions,
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
