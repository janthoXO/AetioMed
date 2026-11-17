import type { Diagnosis } from "@/core/graph/shared/domain/Diagnosis.js";
import type { Difficulty } from "@/core/graph/shared/domain/Difficulty.js";
import {
  freezeGeneral,
  joinOutline,
  withSectionBody,
  type OutlineSegments,
} from "@/core/graph/shared/outline/segments.js";
import { getRequestContext } from "@/core/graph/utils/context.js";
import {
  refineOutline,
  type RefineLevel,
  type Refinement,
} from "@/core/graph/02-plan/02-outline/refine.gateway.js";
import { evaluateOutline } from "@/core/graph/02-plan/02-outline/gateway.js";
import type { Recipe } from "@/core/graph/02-plan/02-outline/recipe.js";
import type { GraphRuntime } from "./runtime.js";

export type { RefineLevel, Refinement };

/** What every refiner call about one plan shares. */
export type PlanFacts = {
  plan: OutlineSegments;
  /** Language of the plan's bodies (`GenerationContext.planLanguage`). */
  planLanguage: string;
  diagnosis: Diagnosis;
  difficulty: Difficulty;
  recipe: Recipe;
};

/** `plan` with `sections` (new bodies by heading index) applied, General re-frozen (#221). */
export function applySections(
  plan: OutlineSegments,
  sections: Map<number, string>
): OutlineSegments {
  return freezeGeneral(
    [...sections].reduce(
      (acc, [index, body]) => withSectionBody(acc, index, body),
      plan
    )
  );
}

/**
 * Refine (#272) over the plan graph's gateways, outside the compiled graphs:
 * `refine` picks a request's level and, at outline level, the changed
 * sections; `settle` applies them and runs the outline judge as a safety
 * net, with one section-replacement revision when it rejects.
 */
export function makeRefiner(runtime: GraphRuntime) {
  const language = (facts: PlanFacts) =>
    facts.planLanguage === "en" ? undefined : facts.planLanguage;

  return {
    refine(
      facts: PlanFacts,
      request: {
        target: string;
        alts?: string[] | undefined;
        instruction: string;
        levels: RefineLevel[];
      }
    ): Promise<Refinement> {
      return refineOutline(
        runtime,
        {
          ...facts,
          ...request,
          request: request.instruction,
          language: language(facts),
          call: { role: "judge", temperature: "balanced" },
        },
        getRequestContext()
      );
    },

    async settle(
      facts: PlanFacts,
      sections: Map<number, string>
    ): Promise<{ plan: OutlineSegments; sections: Map<number, string> }> {
      const plan = applySections(facts.plan, sections);
      const verdict = await evaluateOutline(
        runtime,
        facts.diagnosis,
        joinOutline(plan),
        facts.difficulty,
        facts.recipe,
        undefined,
        getRequestContext(),
        language(facts)
      );
      if (verdict.accepted) return { plan, sections };
      runtime.log.info(
        `[Refine] Judge rejected the refined outline: ${verdict.reasons.join("; ")}`
      );
      const revision = await refineOutline(
        runtime,
        {
          ...facts,
          plan,
          target: "the whole outline",
          request: `A reviewer rejected the outline. Revise only what is needed to address:\n${[...verdict.reasons, verdict.suggestion ?? ""].filter(Boolean).join("\n")}`,
          levels: ["outline"],
          language: language(facts),
          call: { role: "judge", temperature: "balanced" },
        },
        getRequestContext()
      );
      // ponytail: one revision, then shown as is; the user reviews the proposal.
      const merged = new Map([...sections, ...revision.sections]);
      return { plan: applySections(facts.plan, merged), sections: merged };
    },
  };
}

export type Refiner = ReturnType<typeof makeRefiner>;
