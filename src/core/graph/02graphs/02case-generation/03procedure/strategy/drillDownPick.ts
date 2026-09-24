import {
  generateBlindedProcedureStep,
  pickBridgeProcedures,
  planProcedureResults,
  selectProcedureLevel,
  type LevelSelection,
} from "@/core/graph/03aigateway/procedures.aigateway.js";
import type {
  LevelItem,
  ProcedureCandidates,
} from "@/core/graph/catalog/ports.js";
import type { PlannedProcedure } from "@/core/graph/models/Procedure.js";
import type { ProcedureRef } from "@/core/graph/models/ProcedureTree.js";
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

/** A pick is offered at most this many procedures; a larger catalogue is narrowed first. */
export const MAX_PICK_CANDIDATES = 255;

/**
 * Narrows `candidates` level by level until fewer than
 * {@link MAX_PICK_CANDIDATES} remain: the model keeps categories and single
 * procedures from the root level; kept procedures stay, kept categories open
 * one level deeper, until the pool is small enough or nothing is left to open.
 * Terminates: each round opens strictly deeper paths of a finite tree.
 * `select`'s `first` lets only the first level offer a diagnosis.
 *
 * ponytail: one category holding ≥ MAX_PICK_CANDIDATES direct procedures still
 * yields an oversized level; split such a category in the catalogue.
 */
export async function drillDown(
  candidates: ProcedureCandidates,
  select: (items: LevelItem[], first: boolean) => Promise<LevelSelection>
): Promise<
  | { candidates: ProcedureCandidates }
  | { diagnosed: Extract<LevelSelection, { action: "diagnose" }> }
> {
  const kept: ProcedureRef[] = [];
  let open: string[][] = [[]];
  for (let first = true; ; first = false) {
    const selection = await select(candidates.levelItems(open), first);
    if (selection.action === "diagnose") return { diagnosed: selection };

    const categories = selection.items.flatMap((item) =>
      item.kind === "category" ? [item.path] : []
    );
    kept.push(
      ...selection.items.flatMap((item) =>
        item.kind === "procedure" ? [item.ref] : []
      )
    );
    const pool = candidates.narrow(kept, categories);
    if (categories.length === 0 || (pool.size() ?? 0) < MAX_PICK_CANDIDATES) {
      return { candidates: pool };
    }
    open = categories;
  }
}

function needsNarrowing(candidates: ProcedureCandidates): boolean {
  return (candidates.size() ?? 0) >= MAX_PICK_CANDIDATES;
}

/**
 * The only `ProcedureStrategy`. Blinded step: pick from what is left to
 * order, after {@link drillDown} when that is {@link MAX_PICK_CANDIDATES} or
 * more. Bridge: same narrowing with the diagnosis known, then
 * `planProcedureResults` (same planner as `result_step`).
 */
export class DrillDownPick implements ProcedureStrategy {
  readonly id = "drill-down-pick";

  constructor(
    private readonly runtime: GraphRuntime,
    private readonly providers: ModalityProvider<unknown>[]
  ) {}

  async nextStep(view: BlindedView): Promise<SolverMove> {
    const { runtime } = this;
    let candidates = runtime.catalogs.procedures
      .candidates()
      .exclude(view.previousProcedures);
    let allowDiagnose = true;

    if (needsNarrowing(candidates)) {
      const narrowed = await drillDown(candidates, (items, first) =>
        invokeLogged(
          runtime,
          selectProcedureLevel(
            runtime,
            {
              mode: "blinded",
              presentation: view.presentation,
              previousProcedures: view.previousProcedures,
              ruledOutDiagnoses: view.ruledOutDiagnoses,
              userInstructions: view.userInstructions,
              iterationsRemaining: view.iterationsRemaining,
              allowDiagnose: first,
            },
            items,
            view.context
          ),
          "Error selecting a catalogue level"
        ).then((selection) => logSelection(runtime, selection))
      );
      if ("diagnosed" in narrowed) return toSolverMove(narrowed.diagnosed);
      candidates = narrowed.candidates;
      allowDiagnose = false;
    }

    const step = await invokeLogged(
      runtime,
      generateBlindedProcedureStep(
        runtime,
        candidates,
        view.presentation,
        view.previousProcedures,
        view.ruledOutDiagnoses,
        view.userInstructions,
        view.iterationsRemaining,
        view.context,
        allowDiagnose
      ),
      "Error in blinded step"
    );

    return toSolverMove(step);
  }

  async bridge(view: OracleView): Promise<PlannedProcedure[]> {
    const { runtime } = this;
    let candidates = runtime.catalogs.procedures
      .candidates()
      .exclude(view.previousProcedures);

    if (needsNarrowing(candidates)) {
      const narrowed = await drillDown(candidates, (items) =>
        invokeLogged(
          runtime,
          selectProcedureLevel(
            runtime,
            {
              mode: "bridge",
              presentation: view.presentation,
              diagnosis: view.diagnosis,
              previousProcedures: view.previousProcedures,
              userInstructions: view.userInstructions,
            },
            items,
            view.context
          ),
          "Error selecting a catalogue level for the bridge"
        ).then((selection) => logSelection(runtime, selection))
      );
      // Bridge mode never diagnoses.
      if ("diagnosed" in narrowed) return [];
      candidates = narrowed.candidates;
    }

    const procedures = await invokeLogged(
      runtime,
      pickBridgeProcedures(
        runtime,
        candidates,
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
      runtime,
      planProcedureResults(
        runtime,
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

function logSelection(
  runtime: GraphRuntime,
  selection: LevelSelection
): LevelSelection {
  runtime.log.info(
    selection.action === "diagnose"
      ? `[ProcedureGraph] Catalogue level: diagnosed "${selection.diagnosisName}"`
      : `[ProcedureGraph] Catalogue level kept: [${selection.items
          .map((item) =>
            item.kind === "category"
              ? `${item.path.join(" › ")} (${item.size})`
              : [...item.ref.path, item.ref.name].join(" › ")
          )
          .join(", ")}]`
  );
  return selection;
}
