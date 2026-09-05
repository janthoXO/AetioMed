import { END, START, StateGraph, type Runtime } from "@langchain/langgraph";
import {
  CaseGenerationStateSchema,
  type CaseGenerationState,
} from "./state.js";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/core/graph/utils/context.js";
import { buildFieldGenerationGraph } from "./02presentation/generation/index.js";
import { buildProcedureGraph } from "./03procedure/index.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { MedicalBasisProvider } from "@/core/graph/medicalBasis/ports.js";
import { resolveAllFragments } from "@/core/graph/medicalBasis/registry.js";
import type { ModalityProvider } from "@/core/graph/modality/ports.js";
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

// ─── graph ────────────────────────────────────────────────────────────────────

export function buildCaseGenerationGraph(
  runtime: GraphRuntime,
  procedureStrategy: ProcedureStrategy,
  medicalBasisRegistry: MedicalBasisProvider[],
  modalityRegistry: ModalityProvider[],
  traceNode: ReturnType<typeof createTraceNode>
) {
  const presentationPhase = buildFieldGenerationGraph(
    runtime,
    modalityRegistry,
    // Scoped to match the `"presentation_phase"`/`"procedure_phase"` mount
    // names below — see `nodeWrapper.ts`'s `TraceNodeFn.scope` doc comment
    // (issue 15 §3/§4).
    traceNode.scope("presentation_phase")
  );
  const procedurePhase = buildProcedureGraph(
    runtime,
    procedureStrategy,
    traceNode.scope("procedure_phase")
  );

  const gotoProcedureOrEnd = (state: { generationFlags: string[] }) =>
    state.generationFlags.includes("procedures") ? "generate" : "skip";

  // The two branches are written out in full rather than conditionally
  // chained, mirroring `caseGraph.ts`'s `assembleCaseGraph`: LangGraph
  // accumulates node names into the builder's type parameter, so a
  // conditionally-extended builder loses the very typing that makes
  // `addEdge(...)` checkable. An empty registry is the absent-capability-⇒
  // -absent-node rule again (see `medicalBasis/registry.ts`'s
  // `createMedicalBasisRegistry` doc comment) — with zero providers,
  // `basis_resolve` does not exist in the compiled graph at all, not a node
  // that runs and does nothing.
  if (medicalBasisRegistry.length === 0) {
    return new StateGraph(CaseGenerationStateSchema, RequestContextSchema)
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

  return (
    new StateGraph(CaseGenerationStateSchema, RequestContextSchema)
      .addNode(
        "basis_resolve",
        traceNode(
          "basis_resolve",
          makeResolveMedicalBasis(runtime, medicalBasisRegistry),
          "Resolving medical basis"
        )
      )
      // The presentation phase is the field-generation graph mounted
      // directly: consistency is judged on the outline inside its evaluate ⇄
      // revise loop, so there is no post-fan-out consistency check.
      .addNode("presentation_phase", presentationPhase)
      .addNode("procedure_phase", procedurePhase)

      .addEdge(START, "basis_resolve")
      .addEdge("basis_resolve", "presentation_phase")
      .addConditionalEdges("presentation_phase", gotoProcedureOrEnd, {
        generate: "procedure_phase",
        skip: END,
      })
      .addEdge("procedure_phase", END)
      .compile()
  );
}
