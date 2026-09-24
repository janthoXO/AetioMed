import type { BlindedProcedureStepResult } from "@/core/graph/03aigateway/procedures.aigateway.js";
import type { SolverMove } from "./ports.js";

/**
 * `BlindedProcedureStepResult` to `SolverMove`. Non-empty procedure pick
 * orders; diagnose with name commits; procedure action with empty array is
 * "empty pick"; else "unexpected shape" (the two `exhausted` reasons).
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
