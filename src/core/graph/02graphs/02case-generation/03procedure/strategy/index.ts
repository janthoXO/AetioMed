import type { GraphRuntime } from "@/core/graph/runtime.js";
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
 * Assembly-time selection between the two `ProcedureStrategy` adapters —
 * called from `assembleCaseGraph` (`02graphs/caseGraph.ts`) once per
 * compiled variant, and threaded down as a constructed `ProcedureStrategy`.
 * It takes the flag itself rather than `Config` so that nothing on the
 * assembly path sees deployment config: that is what makes "no graph node
 * reads `PROCEDURE_PRESELECTION` at runtime" true by construction rather
 * than by inspection, and what lets a test inject a fake strategy directly
 * into `buildProcedureGraph`.
 *
 * `CategoryScopedPick` is returned only when `PROCEDURE_PRESELECTION` is set
 * **and** the approved procedure list actually has real categories — this
 * second condition (today's `useSmallModelSplit`) is not optional: a flat
 * (uncategorized) catalogue has nothing to scope on, and the scoped path
 * against zero categories degenerates.
 */
export function createProcedureStrategy(
  runtime: GraphRuntime,
  procedurePreselection: boolean
): ProcedureStrategy {
  const hasCategories = runtime.catalogs.procedures.categories().length > 0;

  if (procedurePreselection && hasCategories) {
    return new CategoryScopedPick(runtime);
  }

  return new DirectPick(runtime);
}
