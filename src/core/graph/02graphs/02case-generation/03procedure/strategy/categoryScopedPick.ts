import {
  generateBlindedCategoryStep,
  generateBlindedProcedureStepFromCategories,
  generateBridgeCategoryStep,
  pickBridgeProceduresFromCategories,
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
 * Max category-scope expansions per blinded pick. At cap, empty expandable
 * list removes expand branch from schema, forcing a pick. Does not consume
 * `iterationsRemaining`.
 */
const MAX_CATEGORY_EXPANSIONS = 2;

/**
 * `PROCEDURE_PRESELECTION` strategy: category pick, then procedure pick.
 * Selected only when approved list has real categories (`strategy/index.ts`).
 */
export class CategoryScopedPick implements ProcedureStrategy {
  readonly id = "category-scoped-pick";

  constructor(
    private readonly runtime: GraphRuntime,
    private readonly providers: ModalityProvider<unknown>[]
  ) {}

  /**
   * Category pick, then procedure pick scoped to those categories. Same
   * result shape as `DirectPick`.
   *
   * Procedure pick may "expand" with more categories; loop unions them into
   * local `scope` and retries. Terminates: expand grammar admits only
   * out-of-scope categories, and {@link MAX_CATEGORY_EXPANSIONS} removes the
   * expand branch.
   */
  async nextStep(view: BlindedView): Promise<SolverMove> {
    const { runtime } = this;

    const categoryStep = await invokeLogged(
      runtime,
      generateBlindedCategoryStep(
        runtime,
        view.presentation,
        view.previousProcedures,
        view.ruledOutDiagnoses,
        view.userInstructions,
        view.iterationsRemaining,
        view.context
      ),
      "Error in blinded category step"
    );

    runtime.log.info(
      `[ProcedureGraph] Blinded category step:\n\`\`\`json\n${JSON.stringify(categoryStep, null, 2)}\n\`\`\``
    );

    if (categoryStep.action === "diagnose") {
      return toSolverMove(categoryStep);
    }

    if (
      categoryStep.action !== "categories" ||
      !categoryStep.categories?.length
    ) {
      // Unexpected shape; node fallback handles it.
      return toSolverMove({ action: "procedure", procedures: undefined });
    }

    const allCategories = runtime.catalogs.procedures.categories();
    const scope = new Set(categoryStep.categories);

    for (let expansions = 0; ; expansions++) {
      const expandableCategories =
        expansions < MAX_CATEGORY_EXPANSIONS
          ? allCategories.filter((category) => !scope.has(category))
          : [];

      const pick = await invokeLogged(
        runtime,
        generateBlindedProcedureStepFromCategories(
          runtime,
          view.presentation,
          view.previousProcedures,
          [...scope],
          expandableCategories,
          view.userInstructions,
          view.context
        ),
        "Error in blinded procedure step"
      );

      if (pick.action === "expand" && pick.categories.length > 0) {
        for (const category of pick.categories) scope.add(category);
        runtime.log.info(
          `[ProcedureGraph] Blinded procedure step expanded its scope with [${pick.categories.join(", ")}] (expansion ${expansions + 1}/${MAX_CATEGORY_EXPANSIONS})${pick.reasoning ? ` — ${pick.reasoning}` : ""}`
        );
        continue;
      }

      const procedures = pick.action === "procedures" ? pick.procedures : [];

      runtime.log.info(
        `[ProcedureGraph] Blinded procedure step picked ${procedures.length} procedure(s) from [${[...scope].join(", ")}]:\n\`\`\`json\n${JSON.stringify(procedures, null, 2)}\n\`\`\``
      );

      return toSolverMove({
        action: "procedure",
        procedures,
        reasoning: pick.reasoning ?? categoryStep.reasoning,
      });
    }
  }

  /**
   * Category pick, confirmatory name pick scoped to those categories, then
   * `planProcedureResults` (same planner as `result_step`). Terminal: empty
   * category pick falls back to all categories; empty scoped name pick
   * retries once with all categories. No model-driven expand loop.
   */
  async bridge(view: OracleView): Promise<PlannedProcedure[]> {
    const { runtime } = this;

    const categories = await invokeLogged(
      runtime,
      generateBridgeCategoryStep(
        runtime,
        view.presentation,
        view.diagnosis,
        view.previousProcedures,
        view.userInstructions,
        view.context
      ),
      "Error in bridge category step"
    );

    const allCategories = runtime.catalogs.procedures.categories();
    const selectedCategories = categories.length ? categories : allCategories;

    runtime.log.info(
      `[ProcedureGraph] Bridge category step selected: [${selectedCategories.join(", ")}]${categories.length ? "" : " (fallback: all categories)"}`
    );

    let procedures = await invokeLogged(
      runtime,
      pickBridgeProceduresFromCategories(
        runtime,
        view.presentation,
        view.diagnosis,
        view.previousProcedures,
        selectedCategories,
        view.userInstructions,
        view.context
      ),
      "Error in bridge procedure pick"
    );

    if (
      procedures.length === 0 &&
      selectedCategories.length < allCategories.length
    ) {
      runtime.log.warn(
        `[ProcedureGraph] Bridge pick from [${selectedCategories.join(", ")}] returned no procedures — retrying with all categories.`
      );

      procedures = await invokeLogged(
        runtime,
        pickBridgeProceduresFromCategories(
          runtime,
          view.presentation,
          view.diagnosis,
          view.previousProcedures,
          allCategories,
          view.userInstructions,
          view.context
        ),
        "Error in bridge procedure pick"
      );
    }

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
