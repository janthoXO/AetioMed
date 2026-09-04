import {
  generateBlindedCategoryStep,
  generateBlindedProcedureStepFromCategories,
  generateBridgeCategoryStep,
  generateBridgeProcedureStepFromCategories,
} from "@/core/graph/03aigateway/procedures.aigateway.js";
import type { ProcedureResult } from "@/core/graph/models/Procedure.js";
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
 * Hard cap on category-scope expansions within a single blinded pick: once
 * reached, `nextStep`'s expand loop passes an empty expandable list, which
 * removes the expand branch from the response schema entirely and forces a
 * pick. Expansions do NOT consume the solver's `iterationsRemaining` budget
 * — that budget bounds diagnostic steps, this cap bounds retrieval within
 * one step.
 */
const MAX_CATEGORY_EXPANSIONS = 2;

/**
 * The `PROCEDURE_PRESELECTION` strategy: a category pick followed by a
 * procedure pick, instead of one call against the full candidate list —
 * small-model-friendly prompting. Selected by
 * `createProcedureStrategy` only when the approved procedure list has real
 * categories to scope against (`strategy/index.ts`).
 */
export class CategoryScopedPick implements ProcedureStrategy {
  readonly id = "category-scoped-pick";

  constructor(private readonly runtime: GraphRuntime) {}

  /**
   * Step 1 (category pick) followed by step 2 (procedure pick scoped to
   * those categories), returning a result shaped exactly like `DirectPick`'s
   * so the `blinded_step` node's post-processing doesn't need to know which
   * strategy produced it.
   *
   * The procedure pick may answer with an "expand" action requesting
   * additional categories; the loop below unions them into the scope and
   * retries. The visited set is the local `scope` variable — never the
   * model's memory — and termination is guaranteed twice: the expand
   * grammar only admits categories not yet in scope (monotone scope
   * growth), and once {@link MAX_CATEGORY_EXPANSIONS} is reached the expand
   * branch is removed from the response schema entirely, forcing a pick.
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
      // Unexpected shape — let the node's existing fallback handle it.
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
   * Step 1 (category pick) followed by step 2 (confirmatory results scoped
   * to those categories). The bridge is terminal (no retry loop), so if the
   * category pick comes back empty this falls back to every real category
   * rather than stalling on an unusable candidate set. Unlike `nextStep`
   * there is no model-driven expand loop here: the diagnosis is known, so
   * when the scoped pick yields nothing the scope is deterministically
   * widened to all categories in a single retry.
   */
  async bridge(view: OracleView): Promise<ProcedureResult[]> {
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

    const scopedResults = await invokeLogged(
      runtime,
      generateBridgeProcedureStepFromCategories(
        runtime,
        view.presentation,
        view.diagnosis,
        view.previousProcedures,
        selectedCategories,
        view.userInstructions,
        view.context
      ),
      "Error in bridge procedure step"
    );

    if (
      scopedResults.length > 0 ||
      selectedCategories.length >= allCategories.length
    ) {
      return scopedResults;
    }

    runtime.log.warn(
      `[ProcedureGraph] Bridge pick from [${selectedCategories.join(", ")}] returned no procedures — retrying with all categories.`
    );

    return invokeLogged(
      runtime,
      generateBridgeProcedureStepFromCategories(
        runtime,
        view.presentation,
        view.diagnosis,
        view.previousProcedures,
        allCategories,
        view.userInstructions,
        view.context
      ),
      "Error in bridge procedure step"
    );
  }
}
