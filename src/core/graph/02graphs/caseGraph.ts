import { START, StateGraph, END } from "@langchain/langgraph";
import type { Case } from "../models/Case.js";
import { getRequestContext, RequestContextSchema } from "../utils/context.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import type { GenerationFlag } from "../models/GenerationFlags.js";
import type { UserInstructions } from "../models/UserInstructions.js";
import { buildCaseGenerationGraph } from "./02case-generation/index.js";
import { CaseGenerationStateSchema } from "./02case-generation/state.js";
import { createProcedureStrategy } from "./02case-generation/03procedure/strategy/index.js";
import { buildCaseTranslationFromEnglishGraph } from "./03case-translation-from-english/index.js";
import { LanguageSchema, type Language } from "../models/Language.js";
import type { Difficulty } from "../models/Difficulty.js";
import { GenerationError } from "../errors/AppError.js";
import { buildCaseTranslationToEnglishGraph } from "./01case-translation-to-english/index.js";
import { createTraceNode } from "../utils/nodeWrapper.js";
import type { GraphRuntime } from "../runtime.js";
import type { Config } from "../config.js";
import type { EventBus } from "../../event-bus.js";
import type { Repos } from "../repos.js";

const CaseStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  generationFlags: true,
  difficulty: true,
  case: true,
}).extend({
  language: LanguageSchema.default("English"),
});

/** The repos the case graph's phases need. */
type CaseGraphRepos = Pick<Repos, "symptoms" | "anamnesis" | "procedures">;

/** Everything assembly needs that is *not* a flag. */
export type AssemblyDeps = {
  runtime: GraphRuntime;
  repos: CaseGraphRepos;
  traceNode: ReturnType<typeof createTraceNode>;
};

/**
 * The deployer's topology choices. Both are compiled away — see
 * {@link assembleCaseGraph}'s rule.
 */
export type GraphFlags = {
  translationSandwich: boolean;
  procedurePreselection: boolean;
};

/**
 * All four flag combinations, derived rather than hand-listed so a fifth can
 * never be constructed and a third flag cannot be forgotten here.
 */
export const ALL_GRAPH_FLAGS: readonly GraphFlags[] = [false, true].flatMap(
  (translationSandwich) =>
    [false, true].map((procedurePreselection) => ({
      translationSandwich,
      procedurePreselection,
    }))
);

/** Activated flags, sorted, `+`-joined; `"none"` when none are set. */
export function graphVariantKey(flags: GraphFlags): string {
  const active = [
    ...(flags.procedurePreselection ? ["procedure-preselection"] : []),
    ...(flags.translationSandwich ? ["translation-sandwich"] : []),
  ].sort();
  return active.length > 0 ? active.join("+") : "none";
}

/**
 * The key identifying a compiled *topology*, as opposed to a variant.
 *
 * `PROCEDURE_PRESELECTION` selects a `ProcedureStrategy` adapter; the
 * procedure graph is fixed at three nodes either way (issue 07), so it does
 * not change the shape of anything and does not appear here. Only the
 * translation sandwich does. This is what `exportGraphs.ts` names diagrams
 * by — two topologies, not four — and `caseGraph.test.ts` asserts the
 * premise still holds.
 */
export function graphTopologyKey(
  flags: GraphFlags
): "none" | "translation-sandwich" {
  return flags.translationSandwich ? "translation-sandwich" : "none";
}

/**
 * Assemble a compiled top-level case graph for one set of deployer flags.
 *
 * > **Compile on what the deployer chose; branch on what the caller asked
 * > for.**
 *
 * The next person to touch this will get that backwards, so to be explicit:
 * `TRANSLATION_SANDWICH` and `PROCEDURE_PRESELECTION` are deployment config
 * and are compiled away — **an absent flag means an absent node**, not a
 * node that is skipped and not an edge that always chooses `skip`. With the
 * sandwich off, the two translation nodes and the two conditional edges on
 * `state.language` do not exist at all.
 *
 * `generationFlags`, `difficulty` and `language` are per-request and stay
 * runtime branches. That is why, with the sandwich *on*, the conditional
 * edges on `state.language` remain: whether this deployment can translate is
 * the deployer's choice, but whether this particular request needs to is the
 * caller's. Likewise the conditional edge on the `procedures` generation
 * flag in `02case-generation/index.ts` stays a conditional edge in every
 * variant.
 *
 * Pure wiring: same `(deps, flags)` gives a structurally identical graph, and
 * nothing here performs I/O.
 */
export function assembleCaseGraph(deps: AssemblyDeps, flags: GraphFlags) {
  const { runtime, repos, traceNode } = deps;

  const generationPhase = buildCaseGenerationGraph(
    runtime,
    createProcedureStrategy(runtime, flags.procedurePreselection),
    repos.symptoms,
    traceNode
  );

  // The two branches are written out in full rather than conditionally
  // chained: LangGraph accumulates node names into the builder's type
  // parameter, so a conditionally-extended builder loses the very typing
  // that makes `addEdge("generation_phase", …)` checkable.
  if (!flags.translationSandwich) {
    return new StateGraph(CaseStateSchema, RequestContextSchema)
      .addNode("generation_phase", generationPhase)
      .addEdge(START, "generation_phase")
      .addEdge("generation_phase", END)
      .compile();
  }

  return new StateGraph(CaseStateSchema, RequestContextSchema)
    .addNode("generation_phase", generationPhase)
    .addNode(
      "translation_to_english_phase",
      buildCaseTranslationToEnglishGraph(runtime, traceNode)
    )
    .addNode(
      "translation_from_english_phase",
      buildCaseTranslationFromEnglishGraph(
        runtime,
        { anamnesis: repos.anamnesis, procedures: repos.procedures },
        traceNode
      )
    )

    .addConditionalEdges(
      START,
      (state) =>
        state.language && state.language !== "English" ? "translate" : "skip",
      {
        translate: "translation_to_english_phase",
        skip: "generation_phase",
      }
    )
    .addEdge("translation_to_english_phase", "generation_phase")
    .addConditionalEdges(
      "generation_phase",
      (state) =>
        state.language && state.language !== "English" ? "translate" : "skip",
      {
        translate: "translation_from_english_phase",
        skip: END,
      }
    )
    .addEdge("translation_from_english_phase", END)
    .compile();
}

export type CompiledCaseGraph = ReturnType<typeof assembleCaseGraph>;

/**
 * Builds every flag variant eagerly, and binds `generateCase` to the one the
 * deployer's config selects. Called once from the composition root
 * (`graph/index.ts`) — and once from `exportGraphs.ts`, with a minimal
 * in-memory runtime, purely to render topologies.
 *
 * **Eager, not lazy.** Lazy compilation would move a possible failure from
 * boot to the first request that happened to need that variant.
 *
 * Only one variant is ever served, so the other three earn their place two
 * other ways: they prove every variant compiles at boot rather than at
 * config-change time, and they give `exportGraphs.ts` and the tests a single
 * source of assembly truth instead of a parallel code path that can drift
 * from what actually runs. Compilation is pure wiring with no I/O, so four
 * is cheap.
 *
 * A useful side effect: because the sandwich-on variants are always built,
 * `getKnownLabels()` collects the translation nodes' labels even on a
 * deployment that has the sandwich off — so `validateCatalogsOrExit` still
 * validates `labelTranslations.yml` against the complete key set.
 */
export function buildCaseGraph(
  runtime: GraphRuntime,
  bus: EventBus,
  config: Config,
  repos: CaseGraphRepos
) {
  const deps: AssemblyDeps = {
    runtime,
    repos,
    traceNode: createTraceNode(bus),
  };

  const variants = new Map<string, CompiledCaseGraph>(
    ALL_GRAPH_FLAGS.map((flags) => [
      graphVariantKey(flags),
      assembleCaseGraph(deps, flags),
    ])
  );

  function getCaseGraph(flags: GraphFlags): CompiledCaseGraph {
    const graph = variants.get(graphVariantKey(flags));
    if (!graph) {
      // Unreachable: `ALL_GRAPH_FLAGS` is derived from the same two booleans.
      throw new Error(
        `No compiled graph variant for flags "${graphVariantKey(flags)}"`
      );
    }
    return graph;
  }

  const caseGraph = getCaseGraph({
    translationSandwich: config.TRANSLATION_SANDWICH,
    procedurePreselection: config.PROCEDURE_PRESELECTION,
  });

  /**
   * Execute the case generator graph.
   */
  async function generateCase(
    diagnosis: Diagnosis,
    generationFlags: GenerationFlag[],
    userInstructions?: UserInstructions,
    language?: Language,
    difficulty?: Difficulty
  ): Promise<Case> {
    console.log(
      `[CaseGraph] Starting case generation for:\n`,
      JSON.stringify(
        { diagnosis, userInstructions, generationFlags, difficulty },
        null,
        2
      )
    );

    const context = getRequestContext();

    const result = await caseGraph.invoke(
      {
        diagnosis,
        generationFlags,
        userInstructions,
        language,
        difficulty,
      },
      {
        context: {
          llmConfig: context?.llmConfig,
          jobId: context?.jobId,
        },
        ...(context?.signal !== undefined ? { signal: context.signal } : {}),
      }
    );

    console.log(
      "[CaseGraph] Generation complete",
      JSON.stringify(result, null, 2)
    );

    if (!result.case) {
      throw new GenerationError("Case generation failed: No case generated");
    }

    return result.case;
  }

  return { caseGraph, getCaseGraph, generateCase };
}
