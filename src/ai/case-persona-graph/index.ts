import { END, START, StateGraph } from "@langchain/langgraph";
import {
  GlobalStateSchema,
  GraphInputSchema,
  type GlobalState,
} from "./state.js";
import type { Case } from "@/domain-models/Case.js";
import type { GenerationFlag } from "@/domain-models/GenerationFlags.js";

import { GenerationError } from "@/errors/AppError.js";
import type { AnamnesisCategory } from "@/domain-models/Anamnesis.js";
import type { Diagnosis } from "@/domain-models/Diagnosis.js";
import { chiefComplaintGraph } from "./chiefComplaint/index.js";
import { anamnesisGraph } from "./anamnesis/index.js";
import { inconsistencyGraph } from "./inconsistency/index.js";
import { passthrough } from "../graph.utils.js";
import { symptomsGraph } from "./symptom/index.js";

/**
 * Build and compile the Council-Consistency-Refinement graph
 */
export function buildCasePersonaGraph() {
  // Create the state graph with our annotation schema
  const graph = new StateGraph(GlobalStateSchema, {
    input: GraphInputSchema,
  })
    .addNode("symptom_phase", symptomsGraph)
    .addNode("chief_complaint_phase", chiefComplaintGraph)
    .addNode("chief_complaint_after", passthrough)
    .addNode("anamnesis_phase", anamnesisGraph)
    .addNode("loop_entry", passthrough)
    .addNode("inconsistency_phase", inconsistencyGraph)

    .addEdge(START, "symptom_phase")
    .addConditionalEdges(
      "symptom_phase",
      (state: GlobalState) => {
        return state.generationFlags.includes("chiefComplaint")
          ? "generate"
          : "skip";
      },
      {
        generate: "chief_complaint_phase",
        skip: "chief_complaint_after",
      }
    )
    .addEdge("chief_complaint_phase", "chief_complaint_after")
    .addConditionalEdges(
      "chief_complaint_after",
      (state: GlobalState) => {
        return state.generationFlags.includes("anamnesis")
          ? "generate"
          : "skip";
      },
      {
        generate: "anamnesis_phase",
        skip: "loop_entry",
      }
    )
    .addEdge("anamnesis_phase", "loop_entry")
    .addConditionalEdges(
      "loop_entry",
      (state: GlobalState) => {
        return state.refinementIterationsRemaining > 0 ? "continue" : "end";
      },
      {
        end: END,
        // inconsistencies generation should then decrease the iteration count
        continue: "inconsistency_phase",
      }
    )
    .addEdge("inconsistency_phase", "loop_entry");
  const compiledGraph = graph.compile();

  console.log("[GraphBuilder] Case Persona graph compiled");

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
  const graph = buildCasePersonaGraph();

  console.log(
    `[CasePersonaGraph] Starting case generation for:\n`,
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
    "[CasePersonaGraph] Generation complete",
    JSON.stringify(result, null, 2)
  );

  if (!result.case) {
    throw new GenerationError("Case generation failed: No case generated");
  }

  return result.case;
}
