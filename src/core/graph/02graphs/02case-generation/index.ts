import { END, START, StateGraph } from "@langchain/langgraph";
import { CaseGenerationStateSchema } from "./state.js";
import { RequestContextSchema } from "@/core/graph/utils/context.js";
import { buildSymptomsGraph } from "./01symptom/index.js";
import { buildFieldGenerationGraph } from "./02presentation/generation/index.js";
import { buildProcedureGraph } from "./03procedure/index.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { Config } from "@/core/graph/config.js";
import type { SymptomsRepo } from "@/core/graph/03repo/symptoms.repo.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";

// ─── graph ────────────────────────────────────────────────────────────────────

export function buildCaseGenerationGraph(
  runtime: GraphRuntime,
  config: Config,
  symptomsRepo: SymptomsRepo,
  traceNode: ReturnType<typeof createTraceNode>
) {
  return (
    new StateGraph(CaseGenerationStateSchema, RequestContextSchema)
      // The presentation phase is the field-generation graph mounted directly:
      // consistency is judged on the outline inside its evaluate ⇄ revise loop,
      // so there is no post-fan-out consistency check.
      .addNode(
        "symptom_phase",
        buildSymptomsGraph(runtime, symptomsRepo, traceNode)
      )
      .addNode(
        "presentation_phase",
        buildFieldGenerationGraph(runtime, traceNode)
      )
      .addNode(
        "procedure_phase",
        buildProcedureGraph(runtime, config, traceNode)
      )

      .addEdge(START, "symptom_phase")
      .addEdge("symptom_phase", "presentation_phase")
      .addConditionalEdges(
        "presentation_phase",
        (state) =>
          state.generationFlags.includes("procedures") ? "generate" : "skip",
        { generate: "procedure_phase", skip: END }
      )
      .addEdge("procedure_phase", END)
      .compile()
  );
}
