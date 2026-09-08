import type { Presentation } from "@/core/graph/03aigateway/procedures.aigateway.js";
import type {
  Procedure,
  ProcedureResult,
} from "@/core/graph/models/Procedure.js";
import type { Diagnosis } from "@/core/graph/models/Diagnosis.js";
import type { RequestContext } from "@/core/graph/utils/context.js";

/**
 * The blinded solver's view of the case. This type **structurally cannot
 * carry the diagnosis** — that is the whole point: the information
 * asymmetry between the blinded solver and the non-blinded oracle steps
 * (`result_step`, `bridge`) is the pipeline's best idea, and making it a
 * compile error to pass the diagnosis into a `ProcedureStrategy.nextStep`
 * call is what turns "maintained by convention" into "maintained by the type
 * system". See `03procedure/index.ts`'s `BlindedSolverStateSchema` for the
 * runtime backstop on top of this compile-time guarantee.
 */
export type BlindedView = {
  presentation: Presentation;
  previousProcedures: ProcedureResult[];
  ruledOutDiagnoses: string[];
  userInstructions?: string | undefined;
  iterationsRemaining: number;
  context?: RequestContext | undefined;
};

/** The (non-blinded) oracle's view of the case — the true diagnosis is known. */
export type OracleView = {
  presentation: Presentation;
  diagnosis: Diagnosis;
  previousProcedures: ProcedureResult[];
  userInstructions?: string | undefined;
  context?: RequestContext | undefined;
};

/**
 * What a blinded solver step decides. `exhausted` replaces the old
 * empty-pick-means-bridge inference: it collapses "the solver had nothing
 * left worth ordering" and "the model returned an unexpected response shape"
 * into one move, while `reason` keeps the two cases distinguishable so the
 * `blinded_step` node can still log the second one at `warn` — losing that
 * warning would hide a real symptom of a misbehaving model.
 *
 * `order` carries a **non-empty** `procedures` array by construction — an
 * empty pick is `exhausted`, not an `order`. This is asserted in the
 * adapters (`directPick.ts`, `categoryScopedPick.ts` via `solverMove.ts`),
 * not in the node.
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
 * The two procedure-selection strategies the blinded solver can run under —
 * `DirectPick` (one LLM call against the full candidate list per step) and
 * `CategoryScopedPick` (a category pick followed by a scoped procedure pick,
 * for small-model-friendly prompting). Selected once at graph-assembly time
 * by `createProcedureStrategy` (`strategy/index.ts`) — no graph node reads
 * `PROCEDURE_PRESELECTION` at runtime.
 */
export interface ProcedureStrategy {
  /** "direct-pick" | "category-scoped-pick" — for logs and tests. */
  readonly id: string;
  nextStep(view: BlindedView): Promise<SolverMove>;
  bridge(view: OracleView): Promise<ProcedureResult[]>;
}
