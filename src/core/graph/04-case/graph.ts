import { END, START, StateGraph } from "@langchain/langgraph";
import { CaseGenerationStateSchema } from "@/core/graph/shared/caseGenerationState.js";
import { RequestContextSchema } from "@/core/graph/utils/context.js";
import { buildFieldGenerationGraph } from "@/core/graph/04-case/01-presentation/graph.js";
import { buildProcedureGraph } from "@/core/graph/04-case/02-procedures/graph.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { ModalityRegistries } from "@/core/graph/shared/modality/registry.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import type { ProcedureStrategy } from "@/core/graph/04-case/02-procedures/solver/ports.js";

const CaseGenerationOutputSchema = CaseGenerationStateSchema.pick({
  case: true,
});

/** Every case field from a handed-in outline. Presentation phase fans out to field generators; procedure phase follows when `procedures` flag set. */
export function buildCaseGenerationGraph(
  runtime: GraphRuntime,
  procedureStrategy: ProcedureStrategy,
  modalityRegistries: ModalityRegistries,
  traceNode: ReturnType<typeof createTraceNode>
) {
  const presentationPhase = buildFieldGenerationGraph(
    runtime,
    modalityRegistries,
    // Scoped to match `"presentation_phase"`/`"procedures_phase"` mount names; see `TraceNodeFn.scope`.
    traceNode.scope("presentation_phase")
  );
  const procedurePhase = buildProcedureGraph(
    runtime,
    procedureStrategy,
    modalityRegistries.procedureResult,
    traceNode.scope("procedures_phase")
  );

  const gotoProcedureOrEnd = (state: { generationFlags: string[] }) =>
    state.generationFlags.includes("procedures") ? "generate" : "skip";

  return new StateGraph(CaseGenerationStateSchema, {
    context: RequestContextSchema,
    output: CaseGenerationOutputSchema,
  })
    .addNode("presentation_phase", presentationPhase)
    .addNode("procedures_phase", procedurePhase)
    .addEdge(START, "presentation_phase")
    .addConditionalEdges("presentation_phase", gotoProcedureOrEnd, {
      generate: "procedures_phase",
      skip: END,
    })
    .addEdge("procedures_phase", END)
    .compile();
}
