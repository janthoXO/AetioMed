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
 * Default strategy: one LLM call against full candidate list per blinded
 * step. Bridge: `pickBridgeProcedures` for names, then `planProcedureResults`
 * (same planner as `result_step`). Used when `PROCEDURE_PRESELECTION` unset
 * or list has no categories (`strategy/index.ts`).
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
