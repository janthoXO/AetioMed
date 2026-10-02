import { buildPrompt, section } from "@/core/graph/shared/prompt/prompt.js";
import {
  leaves,
  refKey,
  refLabel,
  type ProcedureRef,
} from "@/core/graph/shared/domain/ProcedureTree.js";
import type { PlannedProcedure } from "@/core/graph/shared/domain/Procedure.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import { presentationSection } from "../prompt.js";
import {
  decideBlindedCommit,
  previousProceduresSection,
  ruledOutSection,
} from "./gateway.js";
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
 * System One decider picks by one `noul` per remaining catalogue procedure:
 * P(yes) ≥ `pickThreshold`, highest first, at most `pickMax`, top-1 when
 * nothing passes. Not a threshold over one `choice`: its distribution sums to
 * 1, so five equally indicated tests would each score ~0.2 and none pass.
 *
 * Bridge (non-blinded oracle) and freeform catalogues stay with `fallback`.
 *
 * ponytail: nouls are asked in isolation, so redundant tests (troponin +
 * CK-MB) both pass; `pickMax` is the only cost pressure.
 */
export class SystemOnePick implements ProcedureStrategy {
  readonly id = "system-one-pick";

  constructor(
    private readonly runtime: GraphRuntime,
    private readonly systemOne: NonNullable<GraphRuntime["systemOne"]>,
    private readonly fallback: ProcedureStrategy
  ) {}

  async nextStep(view: BlindedView): Promise<SolverMove> {
    const { runtime } = this;
    const tree = runtime.catalogs.procedures.tree();
    // Freeform: no closed set to ask about.
    if (!tree) return this.fallback.nextStep(view);

    const ordered = new Set(view.previousProcedures.map(refKey));
    const remaining: ProcedureRef[] = leaves(tree)
      .map(({ path, leaf }) => ({ path, name: leaf.name }))
      .filter((ref) => !ordered.has(refKey(ref)));
    if (remaining.length === 0) {
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
    const probabilities = await invokeLogged(
      runtime,
      this.systemOne.port.noul(
        state,
        Object.fromEntries(
          remaining.map((ref, i) => [
            `p${i}`,
            `Is "${refLabel(ref)}" a high-yield procedure to order next in this diagnostic workup, given the presentation and the results so far?`,
          ])
        ),
        view.context
      ),
      "Error in System One procedure pick"
    );

    const ranked = remaining
      .map((ref, i) => ({ ref, p: probabilities[`p${i}`] ?? 0 }))
      .sort((a, b) => b.p - a.p);
    const passed = ranked
      .filter(({ p }) => p >= this.systemOne.pickThreshold)
      .slice(0, this.systemOne.pickMax);
    const picked = passed.length > 0 ? passed : ranked.slice(0, 1);

    runtime.log.info(
      `[ProcedureGraph] System One pick (threshold ${this.systemOne.pickThreshold}): [${picked
        .map(({ ref }) => refLabel(ref))
        .join(", ")}]; top 10: ${ranked
        .slice(0, 10)
        .map(({ ref, p }) => `${refLabel(ref)} ${p.toFixed(2)}`)
        .join(", ")}`
    );

    return { action: "order", procedures: picked.map(({ ref }) => ref) };
  }

  bridge(view: OracleView): Promise<PlannedProcedure[]> {
    return this.fallback.bridge(view);
  }
}
