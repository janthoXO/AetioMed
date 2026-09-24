import { END, START, StateGraph, type Runtime } from "@langchain/langgraph";
import {
  CaseGenerationStateSchema,
  type CaseGenerationState,
} from "./state.js";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/core/graph/utils/context.js";
import { buildPlanGraph, PlanGraphStateSchema } from "./01plan/index.js";
import { buildFieldGenerationGraph } from "./02presentation/generation/index.js";
import { buildProcedureGraph } from "./03procedure/index.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { MedicalBasisProvider } from "@/core/graph/medicalBasis/ports.js";
import { resolveAllFragments } from "@/core/graph/medicalBasis/registry.js";
import type { ModalityRegistries } from "@/core/graph/modality/registry.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { renderUserInstructions } from "@/core/graph/utils/prompt.js";
import type { ProcedureStrategy } from "./03procedure/strategy/index.js";

// ─── node: resolve the medical basis ──────────────────────────────────────
//
// Runs all providers concurrently; fragments concatenated in *registry* order (`medicalBasis/registry.ts`'s `resolveAllFragments`). Compiled in only when registry non-empty.

function makeResolveMedicalBasis(
  runtime: GraphRuntime,
  providers: MedicalBasisProvider[]
) {
  return async function resolveMedicalBasis(
    state: Pick<
      CaseGenerationState,
      "diagnosis" | "difficulty" | "userInstructions"
    >,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<CaseGenerationState, "basisFragments">> {
    const basisFragments = await resolveAllFragments(
      providers,
      {
        diagnosis: state.diagnosis,
        difficulty: state.difficulty,
        userInstructions: renderUserInstructions(state.userInstructions),
      },
      runtime.log,
      lgRuntime?.context
    );

    return { basisFragments };
  };
}

// ─── graphs ───────────────────────────────────────────────────────────────────

// Both phases mounted in top-level graphs: `planning_phase` in plan graph, `generation_phase` in case graph. `.pick()` off phase state schema.
const PlanningPhaseStateSchema = PlanGraphStateSchema.extend(
  CaseGenerationStateSchema.pick({ generationFlags: true }).shape
);

const PlanningPhaseOutputSchema = PlanningPhaseStateSchema.pick({
  outlineSegments: true,
  outlineAccepted: true,
});

const CaseGenerationOutputSchema = CaseGenerationStateSchema.pick({
  case: true,
});

/** Resolve medical basis, then plan and judge outline. Ends with outline and verdict, no case fields. */
export function buildPlanningPhaseGraph(
  runtime: GraphRuntime,
  medicalBasisRegistry: MedicalBasisProvider[],
  traceNode: ReturnType<typeof createTraceNode>
) {
  // Scoped to match `"outline_phase"` mount name; see `TraceNodeFn.scope`.
  const outlinePhase = buildPlanGraph(
    runtime,
    traceNode.scope("outline_phase")
  );

  // Written out in full, not chained: LangGraph accumulates node names in builder type parameter. Empty registry ⇒ node absent (`medicalBasis/registry.ts`).
  if (medicalBasisRegistry.length === 0) {
    return new StateGraph(PlanningPhaseStateSchema, {
      context: RequestContextSchema,
      output: PlanningPhaseOutputSchema,
    })
      .addNode("outline_phase", outlinePhase)
      .addEdge(START, "outline_phase")
      .addEdge("outline_phase", END)
      .compile();
  }

  return new StateGraph(PlanningPhaseStateSchema, {
    context: RequestContextSchema,
    output: PlanningPhaseOutputSchema,
  })
    .addNode(
      "basis_resolve",
      traceNode(
        "basis_resolve",
        makeResolveMedicalBasis(runtime, medicalBasisRegistry),
        "Resolving medical basis"
      )
    )
    .addNode("outline_phase", outlinePhase)
    .addEdge(START, "basis_resolve")
    .addEdge("basis_resolve", "outline_phase")
    .addEdge("outline_phase", END)
    .compile();
}

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
    // Scoped to match `"presentation_phase"`/`"procedure_phase"` mount names; see `TraceNodeFn.scope`.
    traceNode.scope("presentation_phase")
  );
  const procedurePhase = buildProcedureGraph(
    runtime,
    procedureStrategy,
    modalityRegistries.procedureResult,
    traceNode.scope("procedure_phase")
  );

  const gotoProcedureOrEnd = (state: { generationFlags: string[] }) =>
    state.generationFlags.includes("procedures") ? "generate" : "skip";

  return new StateGraph(CaseGenerationStateSchema, {
    context: RequestContextSchema,
    output: CaseGenerationOutputSchema,
  })
    .addNode("presentation_phase", presentationPhase)
    .addNode("procedure_phase", procedurePhase)
    .addEdge(START, "presentation_phase")
    .addConditionalEdges("presentation_phase", gotoProcedureOrEnd, {
      generate: "procedure_phase",
      skip: END,
    })
    .addEdge("procedure_phase", END)
    .compile();
}
