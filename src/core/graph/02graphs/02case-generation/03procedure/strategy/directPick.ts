import {
  generateBlindedProcedureStep,
  pickBridgeProcedures,
  planProcedureResults,
} from "@/core/graph/03aigateway/procedures.aigateway.js";
import type { PlannedProcedure } from "@/core/graph/models/Procedure.js";
import type { ModalityProvider } from "@/core/graph/modality/ports.js";
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
 * blinded step. The bridge is two calls now instead of one (issue 21 §7):
 * `pickBridgeProcedures` picks confirmatory names, then `planProcedureResults`
 * — the SAME planner `03procedure/index.ts`'s `result_step` calls — plans
 * their results. The default strategy whenever `PROCEDURE_PRESELECTION` is
 * unset, or the approved procedure list has no real categories to scope
 * against (see `strategy/index.ts`).
 */
export class DirectPick implements ProcedureStrategy {
  readonly id = "direct-pick";

  constructor(
    private readonly runtime: GraphRuntime,
    private readonly providers: ModalityProvider<unknown>[]
  ) {}

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

  async bridge(view: OracleView): Promise<PlannedProcedure[]> {
    const procedures = await invokeLogged(
      this.runtime,
      pickBridgeProcedures(
        this.runtime,
        view.presentation,
        view.diagnosis,
        view.previousProcedures,
        view.userInstructions,
        view.context
      ),
      "Error picking bridge procedures"
    );

    if (procedures.length === 0) return [];

    return invokeLogged(
      this.runtime,
      planProcedureResults(
        this.runtime,
        view.presentation,
        view.diagnosis,
        procedures,
        this.providers,
        undefined,
        view.userInstructions,
        view.context
      ),
      "Error planning bridge procedure results"
    );
  }
}
