import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { ModalityProvider } from "@/core/graph/modality/ports.js";
import { CategoryScopedPick } from "./categoryScopedPick.js";
import { DirectPick } from "./directPick.js";
import type { ProcedureStrategy } from "./ports.js";

export type {
  BlindedView,
  OracleView,
  ProcedureStrategy,
  SolverMove,
} from "./ports.js";

/**
 * Assembly-time strategy selection, once per compiled variant. Takes the
 * flag, not `Config`, so no node reads `PROCEDURE_PRESELECTION` at runtime.
 *
 * `CategoryScopedPick` only when flag set **and** list has real categories;
 * a flat catalogue has nothing to scope on.
 *
 * `providers` = `procedureResult` modality registry; both `bridge()`s plan
 * results with it.
 */
export function createProcedureStrategy(
  runtime: GraphRuntime,
  procedurePreselection: boolean,
  providers: ModalityProvider<unknown>[]
): ProcedureStrategy {
  const hasCategories = runtime.catalogs.procedures.categories().length > 0;

  if (procedurePreselection && hasCategories) {
    return new CategoryScopedPick(runtime, providers);
  }

  return new DirectPick(runtime, providers);
}
