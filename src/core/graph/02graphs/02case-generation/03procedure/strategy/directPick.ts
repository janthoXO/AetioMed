import {
  generateBlindedProcedureStep,
  generateDiagnosisBridge,
} from "@/core/graph/03aigateway/procedures.aigateway.js";
import type { ProcedureResult } from "@/core/graph/models/Procedure.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type {
  BlindedView,
  OracleView,
  ProcedureStrategy,
  SolverMove,
} from "./ports.js";
import { invokeLogged } from "./invokeLogged.js";
import { toSolverMove } from "./solverMove.js";

/**
 * Today's un-split path: one LLM call against the full candidate list per
 * blinded step, and one LLM call for the bridge. The default strategy
 * whenever `PROCEDURE_PRESELECTION` is unset, or the approved procedure list
 * has no real categories to scope against (see `strategy/index.ts`).
 */
export class DirectPick implements ProcedureStrategy {
  readonly id = "direct-pick";

  constructor(private readonly runtime: GraphRuntime) {}

  async nextStep(view: BlindedView): Promise<SolverMove> {
    const step = await invokeLogged(
      this.runtime,
      generateBlindedProcedureStep(
        this.runtime,
        view.presentation,
        view.previousProcedures,
        view.ruledOutDiagnoses,
        view.userInstructions,
        view.iterationsRemaining,
        view.context
      ),
      "Error in blinded step"
    );

    return toSolverMove(step);
  }

  async bridge(view: OracleView): Promise<ProcedureResult[]> {
    return invokeLogged(
      this.runtime,
      generateDiagnosisBridge(
        this.runtime,
        view.presentation,
        view.diagnosis,
        view.previousProcedures,
        view.userInstructions,
        view.context
      ),
      "Error generating bridge procedures"
    );
  }
}
