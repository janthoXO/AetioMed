import { END, START, StateGraph } from "@langchain/langgraph";
import { CaseGenerationStateSchema } from "../state.js";
import { RequestContextSchema } from "@/core/graph/utils/context.js";
import { fieldGenerationGraph } from "./generation/index.js";
import { inconsistencyGraph } from "./inconsistency/index.js";

// Sequences field generation (outline → patient/chiefComplaint/anamnesis fan-out)
// → inconsistency check/refine loop. Uses the shared CaseGenerationStateSchema so
// it is type-compatible as a node in the outer caseGenerationGraph.
export const presentationGraph = new StateGraph(
  CaseGenerationStateSchema,
  RequestContextSchema
)
  .addNode("field_generation_phase", fieldGenerationGraph)
  .addNode("inconsistency_phase", inconsistencyGraph)

  .addEdge(START, "field_generation_phase")
  .addEdge("field_generation_phase", "inconsistency_phase")
  .addEdge("inconsistency_phase", END)
  .compile();
