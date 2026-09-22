import { START, StateGraph, END } from "@langchain/langgraph";
import z from "zod";
import type { Case } from "../models/Case.js";
import { getRequestContext, RequestContextSchema } from "../utils/context.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import type { GenerationFlag } from "../models/GenerationFlags.js";
import type { UserInstructions } from "../models/UserInstructions.js";
import {
  buildCaseGenerationGraph,
  buildPlanningPhaseGraph,
} from "./02case-generation/index.js";
import { CaseGenerationStateSchema } from "./02case-generation/state.js";
import { createProcedureStrategy } from "./02case-generation/03procedure/strategy/index.js";
import { buildCaseTranslationFromEnglishGraph } from "./03case-translation-from-english/index.js";
import type { Language } from "../models/Language.js";
import type { Difficulty } from "../models/Difficulty.js";
import { GenerationError } from "../errors/AppError.js";
import { buildCaseTranslationToEnglishGraph } from "./01case-translation-to-english/index.js";
import {
  buildOutlineTranslationGraph,
  translateOutlineValues,
} from "./outline-translation/index.js";
import {
  createTraceNode,
  noopNodeTracer,
  type NodeTracer,
} from "../utils/nodeWrapper.js";
import type { GraphRuntime } from "../runtime.js";
import type { Config } from "../config.js";
import type { EventBus } from "../../event-bus.js";
import type { Repos } from "../repos.js";
import type {
  BasisFragment,
  MedicalBasisProvider,
} from "../medicalBasis/ports.js";
import {
  OutlineSegmentsSchema,
  type OutlineSegments,
} from "../outline/segments.js";
import { RunModeSchema, type RunMode } from "../models/RunMode.js";
import type { ModalityRegistries } from "../modality/registry.js";

// No `language` field (issue 09 §2): the outer graphs resolve language
// before invoke and bind ports to it via `AsyncLocalStorage`
// (`utils/context.ts`), never via graph state — a narrower state schema is a
// real, runtime-enforced boundary (subgraph state is filtered), unlike
// LangGraph's own runtime context, which is not.
//
// The pipeline is two top-level graphs since #159: the **plan graph** ends
// with an outline, the **case graph** starts from one. The seam between
// them is where plan mode pauses for a human reviewer, and where the job
// service checkpoints the outline in both modes.
const PlanStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  generationFlags: true,
  difficulty: true,
  basisFragments: true,
}).extend({
  /**
   * Per-request routing input (issue 12 §3), not ALS: whether the *caller*
   * actually supplied free text — a diagnosis **name** (rather than only an
   * `icd`) or any `userInstructions`. `CaseGenerationService` is the only
   * place that knows this (it performs the ICD→name resolution before the
   * graph ever runs), so it computes this and passes it in. Graph state,
   * not ALS, is where this belongs — #120's rule is *branch on what the
   * caller asked for*, and this is per-request routing input, visible in
   * the graph's input contract; `language` stays on ALS because it is a
   * property of the bound ports (see the comment above), not a per-request
   * routing signal like this one.
   */
  callerSuppliedFreeText: z.boolean(),
  mode: RunModeSchema.default("normal"),
  /**
   * A plan handed in with the request (#159): when set, the plan graph only
   * translates the request in and skips planning — see {@link planOrSkip}.
   */
  outlineSegments: OutlineSegmentsSchema.default([]),
  outlineAccepted: z.boolean().default(false),
});

// The plan graph hands back everything the case graph needs, in the
// working language: after translate-in, `diagnosis`/`userInstructions` are
// English, and they are what the case graph must use.
const PlanOutputSchema = PlanStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  basisFragments: true,
  outlineSegments: true,
  outlineAccepted: true,
});

const CaseStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  generationFlags: true,
  difficulty: true,
  case: true,
}).extend({
  /** The prompt-ready outline text (`joinOutline`) every generator reads. */
  outline: z.string(),
});

const CaseOutputSchema = CaseStateSchema.pick({ case: true });

/**
 * The translate-**out** edge (after generation): does this *request* need
 * its output translated? (`state.language` no longer exists — the
 * deployer's `TRANSLATION_SANDWICH` flag already decided whether the
 * translation nodes are compiled in at all; this decides, per request,
 * whether to enter them.) Reads `getRequestContext()?.language` off ALS,
 * never off graph state or LangGraph's own runtime context — see the
 * `CaseStateSchema` comment above and `utils/context.ts`. Always runs when
 * the language differs, regardless of provenance: generation always runs in
 * English under the sandwich, so the response must be translated back even
 * for an ICD-only request that skipped translate-**in** below.
 */
function requestNeedsTranslationOut(): "translate" | "skip" {
  const language = getRequestContext()?.language;
  return language && language !== "English" ? "translate" : "skip";
}

/**
 * The translate-**in** edge (before generation): issue 12 §3 fixes a bug
 * here. The old predicate fired on `language !== "English"` alone, so an
 * ICD-only request — whose name is already the catalogue's English name —
 * got "translated" anyway, polluting the translation store with identity
 * entries (`German: { "Diabetes": "Diabetes" }`). Trigger on provenance
 * instead: only enter this phase when the language differs **and** the
 * caller actually supplied free text (`state.callerSuppliedFreeText`).
 */
function requestNeedsTranslationIn(state: {
  callerSuppliedFreeText: boolean;
}): "translate" | "skip" {
  const language = getRequestContext()?.language;
  return language && language !== "English" && state.callerSuppliedFreeText
    ? "translate"
    : "skip";
}

/**
 * After translate-in: plan, or — with a plan handed in (#159) — stop, the
 * request's working-language values being all the case graph still needs.
 */
function planOrSkip(state: {
  outlineSegments: OutlineSegments;
}): "planning_phase" | typeof END {
  return state.outlineSegments.length > 0 ? END : "planning_phase";
}

/** The repos the case graph's phases need. */
type CaseGraphRepos = Pick<Repos, "anamnesis" | "procedures">;

/**
 * Everything assembly needs that is *not* a flag. `medicalBasisRegistry` is
 * here rather than in `GraphFlags` deliberately: it is fixed per deployment
 * (constructed once in `graph/index.ts` via
 * `medicalBasis/registry.ts`'s `createMedicalBasisRegistry`), so all four
 * flag variants share it — putting it in `GraphFlags` would multiply the
 * variant count by registry configuration. Its *size* still changes the
 * compiled shape (see `02case-generation/index.ts`'s `buildCaseGenerationGraph`),
 * exactly like the two real flags, just driven by a list rather than a
 * boolean and not itself a deployer-facing env flag (see that module's doc
 * comment on `createMedicalBasisRegistry`).
 */
export type AssemblyDeps = {
  runtime: GraphRuntime;
  repos: CaseGraphRepos;
  medicalBasisRegistry: MedicalBasisProvider[];
  /**
   * The per-field modality registries (issue 21 §4) — in `AssemblyDeps`,
   * not `GraphFlags`, for exactly `medicalBasisRegistry`'s reason above:
   * fixed per deployment, shared by all four flag variants. Unlike
   * `medicalBasisRegistry`, an empty per-field list is a build-time error
   * rather than an absent node (`EmptyModalityRegistryError`,
   * `modality/registry.ts`) — the planner always runs for every field
   * (issue 21 §1), so there is no registry-size topology variance left to
   * drive.
   */
  modalityRegistries: ModalityRegistries;
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
 * sandwich off, the two translation nodes and the two `requestNeedsTranslation*`
 * conditional edges do not exist at all.
 *
 * `generationFlags`, `difficulty` and `language` are per-request and stay
 * runtime branches. That is why, with the sandwich *on*, the two
 * `requestNeedsTranslation*` conditional edges remain: whether this
 * deployment can translate is the deployer's choice, but whether this
 * particular request needs to is the caller's — `language` itself never
 * reaches graph state (see `CaseStateSchema`'s comment); the edges read it
 * off ALS instead. Likewise the conditional edge on the `procedures`
 * generation flag in `02case-generation/index.ts` stays a conditional edge
 * in every variant.
 *
 * Pure wiring: same `(deps, flags)` gives a structurally identical graph, and
 * nothing here performs I/O.
 */
export function assembleCaseGraphs(deps: AssemblyDeps, flags: GraphFlags) {
  const {
    runtime,
    repos,
    medicalBasisRegistry,
    modalityRegistries,
    traceNode,
  } = deps;

  // With the sandwich compiled in, generation always runs in English (issue
  // 09 §3/§4) — the request's real target language only ever reaches the
  // translate-out phase below, built from the *unmodified* `runtime`. This
  // is the one `languageOverride` binding today: see `GraphRuntime`'s doc
  // comment (`runtime.ts`) and `buildSystemPrompt` (`utils/prompt.ts`),
  // which is what actually reads it.
  const generationRuntime: GraphRuntime = flags.translationSandwich
    ? { ...runtime, languageOverride: "English" }
    : runtime;

  // Scoped to match the mount names below — see `nodeWrapper.ts`'s
  // `TraceNodeFn.scope` doc comment (issue 15 §3/§4).
  const planningPhase = buildPlanningPhaseGraph(
    generationRuntime,
    medicalBasisRegistry,
    traceNode.scope("planning_phase")
  );
  const generationPhase = buildCaseGenerationGraph(
    generationRuntime,
    createProcedureStrategy(
      generationRuntime,
      flags.procedurePreselection,
      modalityRegistries.procedureResult
    ),
    modalityRegistries,
    traceNode.scope("generation_phase")
  );

  // Each branch is written out in full rather than conditionally chained:
  // LangGraph accumulates node names into the builder's type parameter, so
  // a conditionally-extended builder loses the very typing that makes
  // `addEdge("planning_phase", …)` checkable.
  if (!flags.translationSandwich) {
    return {
      plan: new StateGraph(PlanStateSchema, {
        context: RequestContextSchema,
        output: PlanOutputSchema,
      })
        .addNode("planning_phase", planningPhase)
        .addConditionalEdges(START, planOrSkip, ["planning_phase", END])
        .addEdge("planning_phase", END)
        .compile(),
      case: new StateGraph(CaseStateSchema, {
        context: RequestContextSchema,
        output: CaseOutputSchema,
      })
        .addNode("generation_phase", generationPhase)
        .addEdge(START, "generation_phase")
        .addEdge("generation_phase", END)
        .compile(),
      // The sandwich's middle layer (#159) exists only when the sandwich
      // does: with it off, plan mode generates the outline directly in the
      // request language, so there is nothing to translate.
      outlineOut: undefined,
      reviewIn: undefined,
    };
  }

  return {
    plan: new StateGraph(PlanStateSchema, {
      context: RequestContextSchema,
      output: PlanOutputSchema,
    })
      .addNode(
        "translation_to_english_phase",
        buildCaseTranslationToEnglishGraph(
          runtime,
          traceNode.scope("translation_to_english_phase")
        )
      )
      .addNode("planning_phase", planningPhase)
      .addConditionalEdges(
        START,
        (state) =>
          requestNeedsTranslationIn(state) === "translate"
            ? "translation_to_english_phase"
            : planOrSkip(state),
        ["translation_to_english_phase", "planning_phase", END]
      )
      .addConditionalEdges("translation_to_english_phase", planOrSkip, [
        "planning_phase",
        END,
      ])
      .addEdge("planning_phase", END)
      .compile(),
    case: new StateGraph(CaseStateSchema, {
      context: RequestContextSchema,
      output: CaseOutputSchema,
    })
      .addNode("generation_phase", generationPhase)
      .addNode(
        "translation_from_english_phase",
        buildCaseTranslationFromEnglishGraph(
          runtime,
          { anamnesis: repos.anamnesis, procedures: repos.procedures },
          traceNode.scope("translation_from_english_phase")
        )
      )
      .addEdge(START, "generation_phase")
      .addConditionalEdges("generation_phase", requestNeedsTranslationOut, {
        translate: "translation_from_english_phase",
        skip: END,
      })
      .addEdge("translation_from_english_phase", END)
      .compile(),
    // The sandwich's middle layer (#159): the outline out to the reviewer
    // and their edits back in. Compiled with the sandwich, entered only by
    // plan-mode requests in a language other than English — never by normal
    // mode. Built from the unmodified `runtime`: they translate to and from
    // the request's real language.
    outlineOut: buildOutlineTranslationGraph(runtime, traceNode, "out"),
    reviewIn: buildOutlineTranslationGraph(runtime, traceNode, "in"),
  };
}

export type CompiledCaseGraphs = ReturnType<typeof assembleCaseGraphs>;
export type CompiledPlanGraph = CompiledCaseGraphs["plan"];
export type CompiledCaseGraph = CompiledCaseGraphs["case"];

/**
 * Builds every flag variant eagerly, and binds `planCase`/`renderCase` to the one the
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
  repos: CaseGraphRepos,
  medicalBasisRegistry: MedicalBasisProvider[],
  modalityRegistries: ModalityRegistries,
  // The OTel operator channel's port (issue #141) — optional and
  // defaulted to the no-op so every existing caller (`exportGraphs.ts`,
  // every test building a graph directly) is unaffected. The composition
  // root (`app.ts`) is the only real caller that passes a constructed one,
  // via `observability/otel.ts`'s `createOtelNodeTracer()`, gated only by
  // the standard `OTEL_SDK_DISABLED` — a separate channel from labels
  // (`core/jobEvents/`, #140), which are always on.
  tracer: NodeTracer = noopNodeTracer
) {
  const deps: AssemblyDeps = {
    runtime,
    repos,
    medicalBasisRegistry,
    modalityRegistries,
    traceNode: createTraceNode(bus, tracer),
  };

  const variants = new Map<string, CompiledCaseGraphs>(
    ALL_GRAPH_FLAGS.map((flags) => [
      graphVariantKey(flags),
      assembleCaseGraphs(deps, flags),
    ])
  );

  function getCaseGraphs(flags: GraphFlags): CompiledCaseGraphs {
    const graphs = variants.get(graphVariantKey(flags));
    if (!graphs) {
      // Unreachable: `ALL_GRAPH_FLAGS` is derived from the same two booleans.
      throw new Error(
        `No compiled graph variant for flags "${graphVariantKey(flags)}"`
      );
    }
    return graphs;
  }

  const graphs = getCaseGraphs({
    translationSandwich: config.TRANSLATION_SANDWICH,
    procedurePreselection: config.PROCEDURE_PRESELECTION,
  });

  /** LangGraph's invoke options for the request bound on ALS. */
  function invokeOptions() {
    const context = getRequestContext();
    return {
      context: { llmConfig: context?.llmConfig, jobId: context?.jobId },
      ...(context?.signal !== undefined ? { signal: context.signal } : {}),
    };
  }

  /**
   * Run the plan graph: translate-in (sandwich on, when needed), the medical
   * basis, and the outline with its judge loop (#159). Returns the outline
   * and the working-language inputs the case graph needs.
   *
   * `language` is not threaded into graph state (see `PlanStateSchema`'s
   * comment above): by the time this runs, `runWithContext` (called by
   * `caseGenerationService.ts`) has already bound it on ALS, so the
   * translation edges and every gateway see it via `getRequestContext()`.
   * `callerSuppliedFreeText` *is* graph state — per-request routing input
   * the translate-in edge reads directly.
   */
  async function planCase(opts: PlanCaseInput): Promise<PlanResult> {
    const result = await graphs.plan.invoke(
      {
        diagnosis: opts.diagnosis,
        generationFlags: opts.generationFlags,
        userInstructions: opts.userInstructions,
        difficulty: opts.difficulty,
        callerSuppliedFreeText: opts.callerSuppliedFreeText,
        mode: opts.mode ?? "normal",
        ...(opts.outline && { outlineSegments: opts.outline }),
      },
      invokeOptions()
    );

    return {
      diagnosis: result.diagnosis,
      userInstructions: result.userInstructions,
      basisFragments: result.basisFragments,
      outlineSegments: result.outlineSegments,
      outlineAccepted: result.outlineAccepted,
    };
  }

  /**
   * Run the case graph from an outline: field fan-out, procedures and (sandwich
   * on, when needed) translate-out. `diagnosis`/`userInstructions` must be the
   * working-language values {@link planCase} returned.
   */
  async function renderCase(opts: RenderCaseInput): Promise<Case> {
    const result = await graphs.case.invoke(
      {
        diagnosis: opts.diagnosis,
        generationFlags: opts.generationFlags,
        userInstructions: opts.userInstructions,
        difficulty: opts.difficulty,
        outline: opts.outline,
      },
      invokeOptions()
    );

    if (!result.case) {
      throw new GenerationError("Case generation failed: No case generated");
    }
    return result.case;
  }

  /**
   * Translate outline values keyed by segment index (#159): `"out"` from
   * English to the request language for the reviewer, `"in"` back to
   * English. `undefined` when the sandwich is compiled out — plan mode then
   * writes the outline in the request language and never translates it.
   */
  const translateOutline =
    graphs.outlineOut && graphs.reviewIn
      ? (values: Record<string, string>, direction: "out" | "in") =>
          translateOutlineValues(
            direction === "out" ? graphs.outlineOut! : graphs.reviewIn!,
            values
          )
      : undefined;

  return {
    graphs,
    getCaseGraphs,
    planCase,
    renderCase,
    translateOutline,
  };
}

export type PlanCaseInput = {
  diagnosis: Diagnosis;
  generationFlags: GenerationFlag[];
  userInstructions?: UserInstructions | undefined;
  language?: Language | undefined;
  difficulty?: Difficulty | undefined;
  callerSuppliedFreeText: boolean;
  mode?: RunMode | undefined;
  /**
   * The plan handed in with the request, in English (#159): planning is
   * skipped and only translate-in runs, so the result's `outlineSegments`
   * is this plan and its `diagnosis`/`userInstructions` are in the working
   * language.
   */
  outline?: OutlineSegments | undefined;
};

export type PlanResult = {
  /** Working language: English after translate-in (sandwich on). */
  diagnosis: Diagnosis;
  userInstructions?: UserInstructions | undefined;
  basisFragments: BasisFragment[];
  outlineSegments: OutlineSegments;
  /** `false` when the judge loop ended on its iteration cap. */
  outlineAccepted: boolean;
};

export type RenderCaseInput = {
  diagnosis: Diagnosis;
  generationFlags: GenerationFlag[];
  userInstructions?: UserInstructions | undefined;
  difficulty?: Difficulty | undefined;
  /** Prompt-ready outline text (`joinOutline`). */
  outline: string;
};
