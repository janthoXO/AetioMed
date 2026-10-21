import { boundLanguage } from "@/core/graph/shared/prompt/prompt.js";
import {
  generateBlindedProcedureStep,
  pickBridgeProcedures,
} from "./gateway.js";
import { planProcedureResults } from "../results.gateway.js";
import type { PlannedProcedure } from "@/core/graph/shared/domain/Procedure.js";
import type { ModalityProvider } from "@/core/graph/shared/modality/ports.js";
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
 * The only `ProcedureStrategy`. Blinded step: one call that orders a
 * non-empty batch from what is left to order, or diagnoses. Bridge: one pick
 * with the diagnosis known, then `planProcedureResults` (same planner as
 * `result_step`).
 */
export class CatalogPick implements ProcedureStrategy {
  readonly id = "catalog-pick";

  constructor(
    private readonly runtime: GraphRuntime,
    private readonly providers: ModalityProvider<unknown>[]
  ) {}

  async nextStep(view: BlindedView): Promise<SolverMove> {
    const { runtime } = this;
    const step = await invokeLogged(
      runtime,
      generateBlindedProcedureStep(
        runtime,
        runtime.catalogs.procedures
          .candidates()
          .exclude(view.previousProcedures),
        view.presentation,
        view.previousProcedures,
        view.ruledOutDiagnoses,
        view.iterationsRemaining,
        view.context,
        // No diagnosis before the first batch: a correct guess ends the loop,
        // and a workup nothing was ordered in leaves `case.procedures` empty.
        view.previousProcedures.length > 0
      ),
      "Error in blinded step"
    );
    return toSolverMove(step);
  }

  async bridge(view: OracleView): Promise<PlannedProcedure[]> {
    const { runtime } = this;
    const procedures = await invokeLogged(
      runtime,
      pickBridgeProcedures(
        runtime,
        runtime.catalogs.procedures
          .candidates()
          .exclude(view.previousProcedures),
        view.presentation,
        view.diagnosis,
        view.previousProcedures,
        view.context
      ),
      "Error picking bridge procedures"
    );

    if (procedures.length === 0) return [];

    return invokeLogged(
      runtime,
      planProcedureResults(
        runtime,
        boundLanguage(runtime),
        view.presentation,
        view.diagnosis,
        procedures,
        this.providers,
        view.proceduresStrategy,
        view.context
      ),
      "Error planning bridge procedure results"
    );
  }
}
