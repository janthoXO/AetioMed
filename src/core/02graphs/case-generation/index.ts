import { END, START, StateGraph } from "@langchain/langgraph";
import { CaseGenerationStateSchema } from "./state.js";
import { symptomsGraph } from "./01symptom/index.js";
import { singleFieldGraph } from "./02singlefield/index.js";
import { multiFieldGraph } from "./02multifield/index.js";
import { RequestContextSchema } from "@/core/utils/context.js";

export const caseGenerationGraph = new StateGraph(
  CaseGenerationStateSchema,
  RequestContextSchema
)
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
  .addEdge("multi_field_phase", END)
  .compile();
