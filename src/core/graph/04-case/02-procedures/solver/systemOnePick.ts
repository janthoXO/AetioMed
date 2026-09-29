import { buildPrompt, section } from "@/core/graph/shared/prompt/prompt.js";
import {
  refLabel,
  type ProcedureRef,
} from "@/core/graph/shared/domain/ProcedureTree.js";
import type { PlannedProcedure } from "@/core/graph/shared/domain/Procedure.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { ProcedureCandidates } from "@/core/graph/catalog/ports.js";
import type { RequestContext } from "@/core/graph/utils/context.js";
import { presentationSection } from "../prompt.js";
import {
  decideBlindedCommit,
  levelItemLabel,
  previousProceduresSection,
  ruledOutSection,
} from "./gateway.js";
import { drillDown } from "./drillDownPick.js";
import { invokeLogged } from "./invokeLogged.js";
import type {
  BlindedView,
  OracleView,
  ProcedureStrategy,
  SolverMove,
} from "./ports.js";

/**
 * Blinded step split in two: an LLM decides diagnose-or-continue
 * (`decideBlindedCommit`, System One cannot name a diagnosis), then the
 * System One decider narrows and picks with `choice` questions. A `choice`
 * distribution ranks its options (it sums to 1, so it is read as a ranking,
 * never against an absolute threshold): {@link nucleus} keeps the top options
 * until their probabilities reach `pickMass`, at most `pickMax`.
 *
 * Narrowing is `drillDown` with the pool limit set to `maxOptions`: one
 * `choice` per level over its categories, the kept categories open, until
 * fewer than `maxOptions` procedures are left; then one `choice` over those,
 * unless the last level already chose among procedures only.
 *
 * Bridge (non-blinded oracle) and freeform catalogues stay with `fallback`.
 *
 * ponytail: a single level with more than 100 items is rejected by
 * laya-serve (413); split such a level in the catalogue.
 */
export class SystemOnePick implements ProcedureStrategy {
  readonly id = "system-one-pick";

  constructor(
    private readonly runtime: GraphRuntime,
    private readonly systemOne: NonNullable<GraphRuntime["systemOne"]>,
    private readonly fallback: ProcedureStrategy
  ) {}

  async nextStep(view: BlindedView): Promise<SolverMove> {
    const { runtime, systemOne } = this;
    const candidates = runtime.catalogs.procedures
      .candidates()
      .exclude(view.previousProcedures);
    // Freeform: no closed set to choose from.
    if (candidates.size() === undefined) return this.fallback.nextStep(view);
    if (candidates.isEmpty()) {
      return { action: "exhausted", reason: "empty pick" };
    }

    // No diagnosis before the first batch (same rule as `DrillDownPick`).
    if (view.previousProcedures.length > 0) {
      const commit = await invokeLogged(
        runtime,
        decideBlindedCommit(
          runtime,
          view.presentation,
          view.previousProcedures,
          view.ruledOutDiagnoses,
          view.userInstructions,
          view.iterationsRemaining,
          view.context
        ),
        "Error deciding whether to diagnose"
      );
      if (commit.action === "diagnose") return commit;
    }

    const state = buildPrompt(
      presentationSection(view.presentation),
      section("Additional instructions", view.userInstructions),
      previousProceduresSection(view.previousProcedures),
      ruledOutSection(view.ruledOutDiagnoses)
    );
    const choose = <T>(
      instructions: string,
      options: T[],
      label: (option: T) => string
    ) => this.choose(state, instructions, options, label, view.context);

    // A level that kept only procedures already was the pick; asking again
    // would only re-rank its own survivors.
    let pickedAtLevel = false;
    const narrowed = await drillDown(
      candidates,
      async (items) => {
        const kept = await choose(
          "Which area of the procedure catalogue holds the most useful next test for this patient's diagnostic workup?",
          items,
          levelItemLabel
        );
        pickedAtLevel = kept.every((item) => item.kind === "procedure");
        return { action: "select", items: kept };
      },
      systemOne.maxOptions
    );
    // Level selections here never diagnose.
    if ("diagnosed" in narrowed) return this.fallback.nextStep(view);

    const pool = procedureRefs(narrowed.candidates);
    const picked = pickedAtLevel
      ? pool.slice(0, systemOne.pickMax)
      : await choose(
          "Which procedure should be ordered next in this patient's diagnostic workup?",
          pool,
          refLabel
        );
    return { action: "order", procedures: picked };
  }

  bridge(view: OracleView): Promise<PlannedProcedure[]> {
    return this.fallback.bridge(view);
  }

  /** One System One `choice` over `options`, read back as its {@link nucleus}; logs the ranking. */
  private async choose<T>(
    state: string,
    instructions: string,
    options: T[],
    label: (option: T) => string,
    context: RequestContext | undefined
  ): Promise<T[]> {
    const { runtime, systemOne } = this;
    const probabilities = await invokeLogged(
      runtime,
      systemOne.port.choice(state, instructions, options.map(label), context),
      "Error in System One choice"
    );
    const ranked = options
      .map((option) => ({ option, p: probabilities[label(option)] ?? 0 }))
      .sort((a, b) => b.p - a.p);
    const kept = nucleus(ranked, systemOne.pickMass, systemOne.pickMax);
    runtime.log.info(
      `[ProcedureGraph] System One choice over ${options.length}: kept [${kept
        .map(label)
        .join(", ")}]; top 5: ${ranked
        .slice(0, 5)
        .map(({ option, p }) => `${label(option)} ${p.toFixed(2)}`)
        .join(", ")}`
    );
    return kept;
  }
}

/**
 * Top of a descending ranking until the kept probabilities sum to `mass`, at
 * most `max`, at least one.
 */
export function nucleus<T>(
  ranked: { option: T; p: number }[],
  mass: number,
  max: number
): T[] {
  const kept: T[] = [];
  let sum = 0;
  for (const { option, p } of ranked) {
    if (kept.length >= max || (kept.length > 0 && sum >= mass)) break;
    kept.push(option);
    sum += p;
  }
  return kept;
}

/** Every procedure left in `candidates`, opening categories until only procedures remain. */
function procedureRefs(candidates: ProcedureCandidates): ProcedureRef[] {
  const refs: ProcedureRef[] = [];
  for (let open: string[][] = [[]]; open.length > 0; ) {
    const items = candidates.levelItems(open);
    refs.push(
      ...items.flatMap((item) => (item.kind === "procedure" ? [item.ref] : []))
    );
    open = items.flatMap((item) =>
      item.kind === "category" ? [item.path] : []
    );
  }
  return refs;
}
