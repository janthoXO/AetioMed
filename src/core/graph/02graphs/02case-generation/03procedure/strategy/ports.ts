import type {
  Presentation,
  PreviousProcedureFinding,
} from "@/core/graph/03aigateway/procedures.aigateway.js";
import type {
  PlannedProcedure,
  Procedure,
} from "@/core/graph/models/Procedure.js";
import type { Diagnosis } from "@/core/graph/models/Diagnosis.js";
import type { RequestContext } from "@/core/graph/utils/context.js";

/**
 * Blinded solver's view. **Structurally cannot carry the diagnosis**:
 * passing it to `nextStep` is a compile error. Runtime backstop:
 * `BlindedSolverStateSchema` in `03procedure/index.ts`.
 */
export type BlindedView = {
  presentation: Presentation;
  previousProcedures: PreviousProcedureFinding[];
  ruledOutDiagnoses: string[];
  userInstructions?: string | undefined;
  iterationsRemaining: number;
  context?: RequestContext | undefined;
};

/** The (non-blinded) oracle's view of the case — the true diagnosis is known. */
export type OracleView = {
  presentation: Presentation;
  diagnosis: Diagnosis;
  previousProcedures: PreviousProcedureFinding[];
  userInstructions?: string | undefined;
  context?: RequestContext | undefined;
};

/**
 * What a blinded solver step decides. `exhausted` covers "nothing left to
 * order" and "unexpected response shape"; `reason` tells them apart so
 * `blinded_step` can warn on the latter.
 *
 * `order` always has non-empty `procedures`; empty pick is `exhausted`.
 * Enforced in adapters via `solverMove.ts`, not the node.
 */
export type SolverMove =
  | { action: "order"; procedures: Procedure[]; reasoning?: string | undefined }
  | {
      action: "diagnose";
      diagnosisName: string;
      reasoning?: string | undefined;
    }
  | { action: "exhausted"; reason: string };

/**
 * Procedure-selection strategy: `DirectPick` or `CategoryScopedPick`.
 * Selected once at assembly by `createProcedureStrategy`.
 */
export interface ProcedureStrategy {
  /** "direct-pick" | "category-scoped-pick" — for logs and tests. */
  readonly id: string;
  nextStep(view: BlindedView): Promise<SolverMove>;
  /**
   * Picks confirmatory procedures for the true diagnosis and plans their
   * results. Returns `PlannedProcedure[]`; `render_results` renders later.
   */
  bridge(view: OracleView): Promise<PlannedProcedure[]>;
}
