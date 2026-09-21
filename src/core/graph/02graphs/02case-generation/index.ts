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
// Runs every registered provider (concurrently) and concatenates their
// fragments in *registry* order, not completion order — see
// `medicalBasis/registry.ts`'s `resolveAllFragments`. Only compiled into the
// graph when the registry is non-empty (see `buildCaseGenerationGraph`
// below); with zero providers there is no basis section at all and nothing
// here runs.

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

// Both phase graphs below are `addNode`'d into `caseGraph.ts`'s top-level
// graphs (issue 17 §1): `planning_phase` into the plan graph,
// `generation_phase` into the case graph (#159). `.pick()` off the phase
// state schema directly, not a hand-written duplicate, so the picked
// channels keep their identical reducer registration.
const PlanningPhaseStateSchema = PlanGraphStateSchema.extend(
  CaseGenerationStateSchema.pick({ generationFlags: true }).shape
);

const PlanningPhaseOutputSchema = PlanningPhaseStateSchema.pick({
  outlineSegments: true,
  outlineAccepted: true,
  basisFragments: true,
});

const CaseGenerationOutputSchema = CaseGenerationStateSchema.pick({
  case: true,
});

/**
 * The planning phase (#159): resolve the medical basis, then plan and judge
 * the outline. Ends with an outline and the judge's verdict — never with
 * any case field. `basisFragments` is written back so a later revision of
 * the outline can reuse it rather than resolve it again.
 */
export function buildPlanningPhaseGraph(
  runtime: GraphRuntime,
  medicalBasisRegistry: MedicalBasisProvider[],
  traceNode: ReturnType<typeof createTraceNode>
) {
  // Scoped to match the `"outline_phase"` mount name below — see
  // `nodeWrapper.ts`'s `TraceNodeFn.scope` doc comment (issue 15 §3/§4).
  const outlinePhase = buildPlanGraph(
    runtime,
    traceNode.scope("outline_phase")
  );

  // Written out in full rather than conditionally chained, mirroring
  // `caseGraph.ts`: LangGraph accumulates node names into the builder's
  // type parameter. An empty registry is the absent-capability-⇒-absent-node
  // rule (see `medicalBasis/registry.ts`'s `createMedicalBasisRegistry`).
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

  return (
    new StateGraph(PlanningPhaseStateSchema, {
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
      // A revision (#159) reuses the basis the first run resolved.
      .addConditionalEdges(
        START,
        (state: { outlineSegments: unknown[] }) =>
          state.outlineSegments.length > 0 ? "outline_phase" : "basis_resolve",
        ["basis_resolve", "outline_phase"]
      )
      .addEdge("basis_resolve", "outline_phase")
      .addEdge("outline_phase", END)
      .compile()
  );
}

/**
 * The generation phase (#159): every case field, from an outline handed in
 * as input. The presentation phase fans the outline out to the field
 * generators; the procedure phase follows when the `procedures` flag is set.
 */
export function buildCaseGenerationGraph(
  runtime: GraphRuntime,
  procedureStrategy: ProcedureStrategy,
  modalityRegistries: ModalityRegistries,
  traceNode: ReturnType<typeof createTraceNode>
) {
  const presentationPhase = buildFieldGenerationGraph(
    runtime,
    modalityRegistries,
    // Scoped to match the `"presentation_phase"`/`"procedure_phase"` mount
    // names below — see `nodeWrapper.ts`'s `TraceNodeFn.scope` doc comment
    // (issue 15 §3/§4).
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
