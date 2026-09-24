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
import type { MedicalBasisProvider } from "../medicalBasis/ports.js";
import {
  OutlineSegmentsSchema,
  type OutlineSegments,
} from "../outline/segments.js";
import { RunModeSchema, type RunMode } from "../models/RunMode.js";
import type { ModalityRegistries } from "../modality/registry.js";

// No `language` field: outer graphs bind ports to language via `AsyncLocalStorage` (`utils/context.ts`), not graph state. Narrower state schema is a runtime-enforced boundary (subgraph state filtered), unlike LangGraph runtime context.
//
// Two top-level graphs: **plan graph** ends with outline, **case graph** starts from one. Plan mode stops at the seam.
const PlanStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  generationFlags: true,
  difficulty: true,
}).extend({
  /** Per-request routing input, not ALS: caller supplied free text (diagnosis **name**, not only `icd`, or any `userInstructions`). Computed by `CaseGenerationService` before ICD→name resolution. `language` stays on ALS: property of bound ports. */
  callerSuppliedFreeText: z.boolean(),
  mode: RunModeSchema.default("normal"),
  /** Plan handed in with request: plan graph only translates request in, skips planning; see {@link planOrSkip}. */
  outlineSegments: OutlineSegmentsSchema.default([]),
  outlineAccepted: z.boolean().default(false),
});

// Plan graph hands back everything case graph needs, in working language (English after translate-in).
const PlanOutputSchema = PlanStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
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
 * Translate-**out** edge (after generation): does this request need output translated? Reads `getRequestContext()?.language` off ALS, never graph state. Fires whenever language differs, regardless of provenance: generation is English under sandwich, so even ICD-only requests translate back.
 */
function requestNeedsTranslationOut(): "translate" | "skip" {
  const language = getRequestContext()?.language;
  return language && language !== "English" ? "translate" : "skip";
}

/**
 * Translate-**in** edge (before generation): enter only when language differs **and** caller supplied free text (`state.callerSuppliedFreeText`). ICD-only names are already catalogue English; translating would pollute store with identity entries (`German: { "Diabetes": "Diabetes" }`).
 */
function requestNeedsTranslationIn(state: {
  callerSuppliedFreeText: boolean;
}): "translate" | "skip" {
  const language = getRequestContext()?.language;
  return language && language !== "English" && state.callerSuppliedFreeText
    ? "translate"
    : "skip";
}

/** After translate-in: plan, or, with plan handed in, stop; working-language values are all case graph needs. */
function planOrSkip(state: {
  outlineSegments: OutlineSegments;
}): "planning_phase" | typeof END {
  return state.outlineSegments.length > 0 ? END : "planning_phase";
}

/** The repos the case graph's phases need. */
type CaseGraphRepos = Pick<Repos, "anamnesis" | "procedures">;

/**
 * Everything assembly needs that is not a flag. `medicalBasisRegistry` is fixed per deployment (`createMedicalBasisRegistry`), shared by all four flag variants. Its *size* still changes compiled shape (`buildCaseGenerationGraph`).
 */
export type AssemblyDeps = {
  runtime: GraphRuntime;
  repos: CaseGraphRepos;
  medicalBasisRegistry: MedicalBasisProvider[];
  /** Per-field modality registries. Fixed per deployment, shared by all variants. Empty per-field list is build-time `EmptyModalityRegistryError` (`modality/registry.ts`); planner always runs, so no topology variance. */
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
 * Key identifying compiled *topology*, not variant. `PROCEDURE_PRESELECTION` swaps a `ProcedureStrategy` adapter; procedure graph stays four nodes, so it is not in key. Only translation sandwich is. `exportGraphs.ts` names diagrams by it; `caseGraph.test.ts` asserts the premise.
 */
export function graphTopologyKey(
  flags: GraphFlags
): "none" | "translation-sandwich" {
  return flags.translationSandwich ? "translation-sandwich" : "none";
}

/**
 * Assemble compiled top-level case graphs for one set of deployer flags.
 *
 * > **Compile on what the deployer chose; branch on what the caller asked for.**
 *
 * `TRANSLATION_SANDWICH` and `PROCEDURE_PRESELECTION` are deployment config, compiled away: **absent flag = absent node**, not a skipped node. Sandwich off: translation nodes and both `requestNeedsTranslation*` edges do not exist.
 *
 * `generationFlags`, `difficulty`, `language` are per-request runtime branches. Sandwich on: both edges remain (deployer chooses whether deployment can translate, caller whether request needs to); they read `language` off ALS. `procedures` conditional edge in `02case-generation/index.ts` stays in every variant.
 *
 * Pure wiring, no I/O: same `(deps, flags)` gives structurally identical graph.
 */
export function assembleCaseGraphs(deps: AssemblyDeps, flags: GraphFlags) {
  const {
    runtime,
    repos,
    medicalBasisRegistry,
    modalityRegistries,
    traceNode,
  } = deps;

  // Sandwich on: generation runs English (`languageOverride` binding, read by `buildSystemPrompt`); real target
  // language reaches only translate-out, built from unmodified `runtime`.
  const generationRuntime: GraphRuntime = flags.translationSandwich
    ? { ...runtime, languageOverride: "English" }
    : runtime;

  // Scoped to match mount names below; see `TraceNodeFn.scope` in `nodeWrapper.ts`.
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

  // Each branch written out in full, not chained: LangGraph accumulates node names in builder type parameter;
  // conditional chaining loses `addEdge("planning_phase", …)` typing.
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
      // Middle layer exists only with sandwich; off, plan mode generates outline directly in request language.
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
    // Middle layer: outline out to reviewer, edits back in. Compiled with sandwich, entered only by plan-mode
    // requests in non-English language. Built from unmodified `runtime`: translates to/from real request language.
    outlineOut: buildOutlineTranslationGraph(runtime, traceNode, "out"),
    reviewIn: buildOutlineTranslationGraph(runtime, traceNode, "in"),
  };
}

export type CompiledCaseGraphs = ReturnType<typeof assembleCaseGraphs>;
export type CompiledPlanGraph = CompiledCaseGraphs["plan"];
export type CompiledCaseGraph = CompiledCaseGraphs["case"];

/**
 * Builds every flag variant eagerly; binds `planCase`/`renderCase` to the one deployer config selects. Called from composition root (`graph/index.ts`) and `exportGraphs.ts` (minimal in-memory runtime, topologies only).
 *
 * Eager so a broken variant fails at boot, not first request. Other three variants give `exportGraphs.ts` and tests one assembly source. Compilation is pure wiring; four is cheap.
 *
 * Sandwich-on variants always built, so `getKnownLabels()` collects translation labels even with sandwich off; `validateCatalogsOrExit` validates `labelTranslations.yml` against the complete key set.
 */
export function buildCaseGraph(
  runtime: GraphRuntime,
  bus: EventBus,
  config: Config,
  repos: CaseGraphRepos,
  medicalBasisRegistry: MedicalBasisProvider[],
  modalityRegistries: ModalityRegistries,
  // OTel operator channel port. Optional, defaults to no-op. Real one comes from `app.ts` via
  // `observability/otel.ts`'s `createOtelNodeTracer()`, gated by `OTEL_SDK_DISABLED`; independent of labels (`core/jobEvents/`).
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
   * Run plan graph: translate-in (sandwich on, when needed), medical basis, outline with judge loop. Returns outline and working-language inputs for case graph.
   *
   * `language` not in graph state: `runWithContext` already bound it on ALS. `callerSuppliedFreeText` is graph state: routing input for translate-in edge.
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

  /** Translate outline values keyed by segment index: `"out"` English → request language, `"in"` back to English. `undefined` when sandwich compiled out. */
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
  /** Plan handed in with request, in English: planning skipped, only translate-in runs; result's `outlineSegments` is this plan, `diagnosis`/`userInstructions` in working language. */
  outline?: OutlineSegments | undefined;
};

export type PlanResult = {
  /** Working language: English after translate-in (sandwich on). */
  diagnosis: Diagnosis;
  userInstructions?: UserInstructions | undefined;
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
