import { END, START, StateGraph } from "@langchain/langgraph";
import { CaseGenerationStateSchema } from "./state.js";
import { RequestContextSchema } from "@/core/graph/utils/context.js";
import { symptomsGraph } from "./01symptom/index.js";
import { presentationGraph } from "./02presentation/index.js";
import { procedureGraph } from "./03procedure/index.js";

// ─── graph ────────────────────────────────────────────────────────────────────

export const caseGenerationGraph = new StateGraph(
  CaseGenerationStateSchema,
  RequestContextSchema
)
  .addNode("symptom_phase", symptomsGraph)
  .addNode("presentation_phase", presentationGraph)
  .addNode("procedure_phase", procedureGraph)

  .addEdge(START, "symptom_phase")
  .addEdge("symptom_phase", "presentation_phase")
  .addConditionalEdges(
    "presentation_phase",
    (state) =>
      state.generationFlags.includes("procedures") ? "generate" : "skip",
    { generate: "procedure_phase", skip: END }
  )
  .addEdge("procedure_phase", END)
  .compile();
