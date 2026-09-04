import {
  Command,
  END,
  START,
  StateGraph,
  type Runtime,
} from "@langchain/langgraph";
import { CaseGenerationStateSchema } from "../state.js";
import z from "zod";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/core/graph/utils/context.js";
import {
  ProcedureSchema,
  type ProcedureResult,
} from "@/core/graph/models/Procedure.js";
import type { Case } from "@/core/graph/models/Case.js";
import { procedureTools } from "./tools.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { renderUserInstructions } from "@/core/graph/utils/prompt.js";
import type {
  Presentation,
  BlindedProcedureStepResult,
} from "@/core/graph/03aigateway/procedures.aigateway.js";
import type { Tool } from "@/core/graph/utils/tool.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { Config } from "@/core/graph/config.js";

// ─── State ────────────────────────────────────────────────────────────────────

const SOLVER_MAX_ITERATIONS = 6;

/**
 * Hard cap on category-scope expansions within a single blinded pick
 * (LLM_SMALL): once reached, {@link resolveBlindedStepViaCategories} passes
 * an empty expandable list, which removes the expand branch from the
 * response schema entirely and forces a pick. Expansions do NOT consume
 * `solverIterationsRemaining` — the solver budget bounds diagnostic steps,
 * this cap bounds retrieval within one step.
 */
const MAX_CATEGORY_EXPANSIONS = 2;

const ProcedureGraphStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  case: true,
  outline: true,
}).extend({
  /** Iterations remaining before the bridge step is forced. */
  solverIterationsRemaining: z.number().default(SOLVER_MAX_ITERATIONS),
  /**
   * The batch of mutually-independent procedures chosen by the blinded step,
   * scheduled together and awaiting their results.
   */
  pendingProcedures: z.array(ProcedureSchema).default([]),
  /** Diagnoses committed to and ruled out in earlier iterations. */
  ruledOutDiagnoses: z.array(z.string()).default([]),
});

type ProcedureGraphState = z.infer<typeof ProcedureGraphStateSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract the presentation slice (no diagnosis, no procedures) from the case. */
function presentationOf(c: Case): Presentation {
  return {
    ...(c.patient !== undefined && { patient: c.patient }),
    ...(c.chiefComplaint !== undefined && { chiefComplaint: c.chiefComplaint }),
    ...(c.anamnesis !== undefined && { anamnesis: c.anamnesis }),
  };
}

/** Serialise only the procedure/general keys from userInstructions. */
function userInstructionsForProcedures(
  userInstructions: ProcedureGraphState["userInstructions"]
): string | undefined {
  if (!userInstructions) return undefined;
  const filtered = Object.fromEntries(
    Object.entries(userInstructions).filter(
      ([key]) => key === "procedures" || key === "general"
    )
  );
  return renderUserInstructions(filtered);
}

/** Read-and-concat append: returns the full updated procedures array. */
function appendProcedures(
  current: ProcedureResult[] | undefined,
  incoming: ProcedureResult[]
): ProcedureResult[] {
  return [...(current ?? []), ...incoming];
}

/** Invoke a tool, logging any error to the generation log before rethrowing. */
async function invokeLogged<TInput, TOutput>(
  runtime: GraphRuntime,
  tool: Tool<TInput, TOutput>,
  input: TInput,
  context: RequestContext | undefined,
  errorLabel: string
): Promise<TOutput> {
  return tool.invoke(input, runtime, context).catch((error) => {
    runtime.log.error(`[ProcedureGraph] ${errorLabel}: ${error}`);
    throw error;
  });
}

/**
 * Whether the small-model-friendly category/procedure split applies: only
 * when `LLM_SMALL` is set AND the approved procedure list actually has real
 * categories — a flat (uncategorized) list has nothing to filter on.
 */
function useSmallModelSplit(runtime: GraphRuntime, config: Config): boolean {
  return (
    !!config.LLM_SMALL && runtime.catalogs.procedures.categories().length > 0
  );
}

// ─── Node 1: blinded_step ─────────────────────────────────────────────────────

/**
 * Small-model-friendly resolution of the blinded step: a category pick
 * followed by a procedure pick, instead of one call against the full list.
 * Not a graph node — just splits the LLM work into sequential tool calls
 * within `blinded_step`'s single invocation, returning a result shaped
 * exactly like {@link BlindedProcedureStepResult} so the caller's existing
 * action-handling logic doesn't need to know which path produced it.
 *
 * The procedure pick may answer with an "expand" action requesting more
 * categories; the loop below unions them into the scope and retries. The
 * visited set is the local `scope` variable — never the model's memory —
 * and termination is guaranteed twice: the expand grammar only admits
 * categories not yet in scope (monotone scope growth), and once
 * {@link MAX_CATEGORY_EXPANSIONS} is reached the expand branch is removed
 * from the response schema entirely, forcing a pick.
 */
async function resolveBlindedStepViaCategories(
  runtime: GraphRuntime,
  presentation: Presentation,
  previousProcedures: ProcedureResult[],
  ruledOutDiagnoses: string[],
  userInstructions: string | undefined,
  iterationsRemaining: number,
  context: RequestContext | undefined
): Promise<BlindedProcedureStepResult> {
  const categoryStep = await invokeLogged(
    runtime,
    procedureTools.generateBlindedCategoryStep,
    {
      presentation,
      previousProcedures,
      ruledOutDiagnoses,
      userInstructions,
      iterationsRemaining,
    },
    context,
    "Error in blinded category step"
  );

  runtime.log.info(
    `[ProcedureGraph] Blinded category step:\n\`\`\`json\n${JSON.stringify(categoryStep, null, 2)}\n\`\`\``
  );

  if (categoryStep.action === "diagnose") {
    return categoryStep;
  }

  if (
    categoryStep.action !== "categories" ||
    !categoryStep.categories?.length
  ) {
    // Unexpected shape — let the caller's existing fallback handle it.
    return { action: "procedure", procedures: undefined };
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
      procedureTools.generateBlindedProcedureStepFromCategories,
      {
        presentation,
        previousProcedures,
        selectedCategories: [...scope],
        expandableCategories,
        userInstructions,
      },
      context,
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

    return {
      action: "procedure",
      procedures,
      reasoning: pick.reasoning ?? categoryStep.reasoning,
    };
  }
}

function makeBlindedStep(runtime: GraphRuntime, config: Config) {
  return async function blindedStep(
    state: ProcedureGraphState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Command> {
    // Force the bridge if we've exhausted the iteration budget.
    if (state.solverIterationsRemaining <= 0) {
      runtime.log.info(
        `[ProcedureGraph] Iteration cap reached — bridging to diagnosis.`
      );
      return new Command({ goto: "bridge" });
    }

    const presentation = presentationOf(state.case);
    const previousProcedures = state.case.procedures ?? [];
    const userInstructions = userInstructionsForProcedures(
      state.userInstructions
    );

    const step = useSmallModelSplit(runtime, config)
      ? await resolveBlindedStepViaCategories(
          runtime,
          presentation,
          previousProcedures,
          state.ruledOutDiagnoses,
          userInstructions,
          state.solverIterationsRemaining,
          lgRuntime?.context
        )
      : await invokeLogged(
          runtime,
          procedureTools.generateBlindedProcedureStep,
          {
            presentation,
            previousProcedures,
            ruledOutDiagnoses: state.ruledOutDiagnoses,
            userInstructions,
            iterationsRemaining: state.solverIterationsRemaining,
          },
          lgRuntime?.context,
          "Error in blinded step"
        );

    runtime.log.info(
      `[ProcedureGraph] Blinded step (${state.solverIterationsRemaining} iter left):\n\`\`\`json\n${JSON.stringify(step, null, 2)}\n\`\`\``
    );

    // ── action: order a batch of mutually-independent procedures ───────────────
    if (step.action === "procedure" && step.procedures?.length) {
      return new Command({
        update: {
          pendingProcedures: step.procedures,
          solverIterationsRemaining: state.solverIterationsRemaining - 1,
        },
        goto: "result_step",
      });
    }

    // ── action: commit to a diagnosis ──────────────────────────────────────────
    if (step.action === "diagnose" && step.diagnosisName) {
      return handleDiagnoseAction(
        runtime,
        state,
        lgRuntime,
        step.diagnosisName
      );
    }

    // ── empty pick: nothing left worth ordering ────────────────────────────────
    if (step.action === "procedure" && step.procedures) {
      // The solver had nothing to order (e.g. all useful candidates already
      // ordered) yet didn't diagnose — bridging is the clinically sensible end.
      runtime.log.info(
        `[ProcedureGraph] Blinded step returned an empty pick — bridging to diagnosis.`
      );
      return new Command({ goto: "bridge" });
    }

    // Unexpected response shape — fall back to bridge.
    runtime.log.warn(
      `[ProcedureGraph] Blinded step returned unexpected shape — bridging.`
    );
    return new Command({ goto: "bridge" });
  };
}

/** Shared diagnose-action handling for `blinded_step` (direct or split path). */
async function handleDiagnoseAction(
  runtime: GraphRuntime,
  state: ProcedureGraphState,
  lgRuntime: Runtime<RequestContext> | undefined,
  diagnosisName: string
): Promise<Command> {
  const matches = await invokeLogged(
    runtime,
    procedureTools.matchDiagnosis,
    { proposedName: diagnosisName, diagnosis: state.diagnosis },
    lgRuntime?.context,
    "Error matching diagnosis"
  );

  runtime.log.info(
    `[ProcedureGraph] Diagnosis "${diagnosisName}" → ${matches ? "✓ match — done" : "✗ no match — continuing"}`
  );

  if (matches) {
    return new Command({ goto: END });
  }

  // Wrong guess: feed it back as ruled-out and keep solving.
  return new Command({
    update: {
      ruledOutDiagnoses: [...state.ruledOutDiagnoses, diagnosisName],
      solverIterationsRemaining: state.solverIterationsRemaining - 1,
    },
    goto: "blinded_step",
  });
}

// ─── Node 2: result_step ──────────────────────────────────────────────────────

function makeResultStep(runtime: GraphRuntime) {
  return async function resultStep(
    state: ProcedureGraphState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Command> {
    const pending = state.pendingProcedures;
    if (!pending.length) {
      // Guard: should not happen in normal flow.
      runtime.log.warn(
        `[ProcedureGraph] result_step called without any pending procedures — skipping.`
      );
      return new Command({ goto: "blinded_step" });
    }

    const completedProcedures: ProcedureResult[] = await invokeLogged(
      runtime,
      procedureTools.generateProcedureResults,
      {
        presentation: presentationOf(state.case),
        diagnosis: state.diagnosis,
        procedureSteps: pending,
        outline: state.outline,
        userInstructions: userInstructionsForProcedures(state.userInstructions),
      },
      lgRuntime?.context,
      `Error generating results for batch [${pending.map((p) => p.name).join(", ")}]`
    );

    const updatedProcedures = appendProcedures(
      state.case.procedures,
      completedProcedures
    );

    runtime.log.info(
      `[ProcedureGraph] Results for batch of ${completedProcedures.length} procedure(s):\n\`\`\`json\n${JSON.stringify(completedProcedures, null, 2)}\n\`\`\``
    );

    return new Command({
      update: {
        case: { procedures: updatedProcedures },
        pendingProcedures: [],
      },
      goto: "blinded_step",
    });
  };
}

// ─── Node 3: bridge ───────────────────────────────────────────────────────────

/**
 * Small-model-friendly resolution of the bridge: a category pick followed by
 * a results pick, instead of one call against the full list. Not a graph
 * node — the bridge is terminal (no retry loop), so if the category pick
 * comes back empty this falls back to every real category rather than
 * stalling on an unusable candidate set. Unlike the blinded step there is no
 * model-driven expand loop here: the diagnosis is known, so when the scoped
 * pick yields nothing the scope is deterministically widened to all
 * categories in a single retry.
 */
async function resolveBridgeViaCategories(
  runtime: GraphRuntime,
  presentation: Presentation,
  diagnosis: ProcedureGraphState["diagnosis"],
  previousProcedures: ProcedureResult[],
  userInstructions: string | undefined,
  context: RequestContext | undefined
): Promise<ProcedureResult[]> {
  const categories = await invokeLogged(
    runtime,
    procedureTools.generateBridgeCategoryStep,
    { presentation, diagnosis, previousProcedures, userInstructions },
    context,
    "Error in bridge category step"
  );

  const allCategories = runtime.catalogs.procedures.categories();
  const selectedCategories = categories.length ? categories : allCategories;

  runtime.log.info(
    `[ProcedureGraph] Bridge category step selected: [${selectedCategories.join(", ")}]${categories.length ? "" : " (fallback: all categories)"}`
  );

  const scopedResults = await invokeLogged(
    runtime,
    procedureTools.generateBridgeProcedureStepFromCategories,
    {
      presentation,
      diagnosis,
      previousProcedures,
      selectedCategories,
      userInstructions,
    },
    context,
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
    procedureTools.generateBridgeProcedureStepFromCategories,
    {
      presentation,
      diagnosis,
      previousProcedures,
      selectedCategories: allCategories,
      userInstructions,
    },
    context,
    "Error in bridge procedure step"
  );
}

function makeBridge(runtime: GraphRuntime, config: Config) {
  return async function bridge(
    state: ProcedureGraphState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Command> {
    runtime.log.info(
      `[ProcedureGraph] Generating bridge procedures to confirm diagnosis…`
    );

    const presentation = presentationOf(state.case);
    const previousProcedures = state.case.procedures ?? [];
    const userInstructions = userInstructionsForProcedures(
      state.userInstructions
    );

    const bridgeProcedures = useSmallModelSplit(runtime, config)
      ? await resolveBridgeViaCategories(
          runtime,
          presentation,
          state.diagnosis,
          previousProcedures,
          userInstructions,
          lgRuntime?.context
        )
      : await invokeLogged(
          runtime,
          procedureTools.generateDiagnosisBridge,
          {
            presentation,
            diagnosis: state.diagnosis,
            previousProcedures,
            userInstructions,
          },
          lgRuntime?.context,
          "Error generating bridge procedures"
        );

    const updatedProcedures = appendProcedures(
      state.case.procedures,
      bridgeProcedures
    );

    runtime.log.info(
      `[ProcedureGraph] Bridge complete — ${bridgeProcedures.length} procedure(s) added:\n\`\`\`json\n${JSON.stringify(bridgeProcedures, null, 2)}\n\`\`\``
    );

    return new Command({
      update: { case: { procedures: updatedProcedures } },
      goto: END,
    });
  };
}

// ─── Graph ────────────────────────────────────────────────────────────────────

export function buildProcedureGraph(
  runtime: GraphRuntime,
  config: Config,
  traceNode: ReturnType<typeof createTraceNode>
) {
  return new StateGraph(ProcedureGraphStateSchema, RequestContextSchema)
    .addNode(
      "blinded_step",
      traceNode(
        "blinded_step",
        makeBlindedStep(runtime, config),
        "Choosing next procedure"
      ),
      { ends: ["result_step", "bridge", END] }
    )
    .addNode(
      "result_step",
      traceNode(
        "result_step",
        makeResultStep(runtime),
        "Generating procedure result"
      ),
      { ends: ["blinded_step"] }
    )
    .addNode(
      "bridge",
      traceNode(
        "bridge",
        makeBridge(runtime, config),
        "Bridging workup to diagnosis"
      ),
      { ends: [END] }
    )
    .addEdge(START, "blinded_step")
    .compile();
}
