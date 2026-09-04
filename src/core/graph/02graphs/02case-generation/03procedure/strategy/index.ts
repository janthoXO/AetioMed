import type { Config } from "@/core/graph/config.js";
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
 * called once from `02case-generation/index.ts` and threaded down as a
 * constructed `ProcedureStrategy`, never as `config` itself. That is what
 * makes "no graph node reads `PROCEDURE_PRESELECTION` at runtime" true by
 * construction rather than by inspection, and what lets a test inject a
 * fake strategy directly into `buildProcedureGraph`.
 *
 * `CategoryScopedPick` is returned only when `PROCEDURE_PRESELECTION` is set
 * **and** the approved procedure list actually has real categories — this
 * second condition (today's `useSmallModelSplit`) is not optional: a flat
 * (uncategorized) catalogue has nothing to scope on, and the scoped path
 * against zero categories degenerates.
 */
export function createProcedureStrategy(
  runtime: GraphRuntime,
  config: Config
): ProcedureStrategy {
  const hasCategories = runtime.catalogs.procedures.categories().length > 0;

  if (config.PROCEDURE_PRESELECTION && hasCategories) {
    return new CategoryScopedPick(runtime);
  }

  return new DirectPick(runtime);
}
