import type { BlindedProcedureStepResult } from "@/core/graph/03aigateway/procedures.aigateway.js";
import type { SolverMove } from "./ports.js";

/**
 * Converts the aigateway's `BlindedProcedureStepResult` shape — shared by
 * `generateBlindedProcedureStep` (`DirectPick`) and, once reconstructed from
 * a category pick, `CategoryScopedPick` — into a `SolverMove`.
 *
 * Mirrors the original `blinded_step` node's three-way branch exactly: a
 * non-empty procedure pick orders, a diagnose action with a name commits, a
 * procedure action with a (possibly empty) `procedures` array is an "empty
 * pick", and anything else is an "unexpected shape" — the two `exhausted`
 * reasons the node logs differently (info vs. warn).
 */
export function toSolverMove(step: BlindedProcedureStepResult): SolverMove {
  if (step.action === "procedure" && step.procedures?.length) {
    return {
      action: "order",
      procedures: step.procedures,
      reasoning: step.reasoning,
    };
  }

  if (step.action === "diagnose" && step.diagnosisName) {
    return {
      action: "diagnose",
      diagnosisName: step.diagnosisName,
      reasoning: step.reasoning,
    };
  }

  if (step.action === "procedure" && step.procedures) {
    return { action: "exhausted", reason: "empty pick" };
  }

  return { action: "exhausted", reason: "unexpected shape" };
}
