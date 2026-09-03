import {
  Command,
  END,
  START,
  StateGraph,
  type Runtime,
} from "@langchain/langgraph";
import { bus, config } from "@/core/graph/index.js";
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
import { traceNode } from "@/core/graph/utils/nodeWrapper.js";
import { renderUserInstructions } from "@/core/graph/utils/prompt.js";
import type {
  Presentation,
  BlindedProcedureStepResult,
} from "@/core/graph/03aigateway/procedures.aigateway.js";
import { procedureCatalog } from "@/core/graph/catalog/index.js";
import type { Tool } from "@/core/graph/utils/tool.js";

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
  tool: Tool<TInput, TOutput>,
  input: TInput,
  context: RequestContext | undefined,
  errorLabel: string
): Promise<TOutput> {
  return tool.invoke(input, context).catch((error) => {
    bus.emit("Generation Log", {
      logLevel: "error",
      timestamp: new Date().toISOString(),
      msg: `[ProcedureGraph] ${errorLabel}: ${error}`,
    });
    throw error;
  });
}

/**
 * Whether the small-model-friendly category/procedure split applies: only
 * when `LLM_SMALL` is set AND the approved procedure list actually has real
 * categories — a flat (uncategorized) list has nothing to filter on.
 */
function useSmallModelSplit(): boolean {
  return config.LLM_SMALL && procedureCatalog.categories().length > 0;
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
  presentation: Presentation,
  previousProcedures: ProcedureResult[],
  ruledOutDiagnoses: string[],
  userInstructions: string | undefined,
  iterationsRemaining: number,
  context: RequestContext | undefined
): Promise<BlindedProcedureStepResult> {
  const categoryStep = await invokeLogged(
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

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[ProcedureGraph] Blinded category step:\n\`\`\`json\n${JSON.stringify(categoryStep, null, 2)}\n\`\`\``,
  });

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

  const allCategories = procedureCatalog.categories();
  const scope = new Set(categoryStep.categories);

  for (let expansions = 0; ; expansions++) {
    const expandableCategories =
      expansions < MAX_CATEGORY_EXPANSIONS
        ? allCategories.filter((category) => !scope.has(category))
        : [];

    const pick = await invokeLogged(
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
      bus.emit("Generation Log", {
        logLevel: "info",
        timestamp: new Date().toISOString(),
        msg: `[ProcedureGraph] Blinded procedure step expanded its scope with [${pick.categories.join(", ")}] (expansion ${expansions + 1}/${MAX_CATEGORY_EXPANSIONS})${pick.reasoning ? ` — ${pick.reasoning}` : ""}`,
      });
      continue;
    }

    const procedures = pick.action === "procedures" ? pick.procedures : [];

    bus.emit("Generation Log", {
      logLevel: "info",
      timestamp: new Date().toISOString(),
      msg: `[ProcedureGraph] Blinded procedure step picked ${procedures.length} procedure(s) from [${[...scope].join(", ")}]:\n\`\`\`json\n${JSON.stringify(procedures, null, 2)}\n\`\`\``,
    });

    return {
      action: "procedure",
      procedures,
      reasoning: pick.reasoning ?? categoryStep.reasoning,
    };
  }
}

async function blindedStep(
  state: ProcedureGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Command> {
  // Force the bridge if we've exhausted the iteration budget.
  if (state.solverIterationsRemaining <= 0) {
    bus.emit("Generation Log", {
      logLevel: "info",
      timestamp: new Date().toISOString(),
      msg: `[ProcedureGraph] Iteration cap reached — bridging to diagnosis.`,
    });
    return new Command({ goto: "bridge" });
  }

  const presentation = presentationOf(state.case);
  const previousProcedures = state.case.procedures ?? [];
  const userInstructions = userInstructionsForProcedures(
    state.userInstructions
  );

  const step = useSmallModelSplit()
    ? await resolveBlindedStepViaCategories(
        presentation,
        previousProcedures,
        state.ruledOutDiagnoses,
        userInstructions,
        state.solverIterationsRemaining,
        runtime?.context
      )
    : await invokeLogged(
        procedureTools.generateBlindedProcedureStep,
        {
          presentation,
          previousProcedures,
          ruledOutDiagnoses: state.ruledOutDiagnoses,
          userInstructions,
          iterationsRemaining: state.solverIterationsRemaining,
        },
        runtime?.context,
        "Error in blinded step"
      );

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[ProcedureGraph] Blinded step (${state.solverIterationsRemaining} iter left):\n\`\`\`json\n${JSON.stringify(step, null, 2)}\n\`\`\``,
  });

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
    return handleDiagnoseAction(state, runtime, step.diagnosisName);
  }

  // ── empty pick: nothing left worth ordering ────────────────────────────────
  if (step.action === "procedure" && step.procedures) {
    // The solver had nothing to order (e.g. all useful candidates already
    // ordered) yet didn't diagnose — bridging is the clinically sensible end.
    bus.emit("Generation Log", {
      logLevel: "info",
      timestamp: new Date().toISOString(),
      msg: `[ProcedureGraph] Blinded step returned an empty pick — bridging to diagnosis.`,
    });
    return new Command({ goto: "bridge" });
  }

  // Unexpected response shape — fall back to bridge.
  bus.emit("Generation Log", {
    logLevel: "warn",
    timestamp: new Date().toISOString(),
    msg: `[ProcedureGraph] Blinded step returned unexpected shape — bridging.`,
  });
  return new Command({ goto: "bridge" });
}

/** Shared diagnose-action handling for `blinded_step` (direct or split path). */
async function handleDiagnoseAction(
  state: ProcedureGraphState,
  runtime: Runtime<RequestContext> | undefined,
  diagnosisName: string
): Promise<Command> {
  const matches = await invokeLogged(
    procedureTools.matchDiagnosis,
    { proposedName: diagnosisName, diagnosis: state.diagnosis },
    runtime?.context,
    "Error matching diagnosis"
  );

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[ProcedureGraph] Diagnosis "${diagnosisName}" → ${matches ? "✓ match — done" : "✗ no match — continuing"}`,
  });

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

async function resultStep(
  state: ProcedureGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Command> {
  const pending = state.pendingProcedures;
  if (!pending.length) {
    // Guard: should not happen in normal flow.
    bus.emit("Generation Log", {
      logLevel: "warn",
      timestamp: new Date().toISOString(),
      msg: `[ProcedureGraph] result_step called without any pending procedures — skipping.`,
    });
    return new Command({ goto: "blinded_step" });
  }

  const completedProcedures: ProcedureResult[] = await invokeLogged(
    procedureTools.generateProcedureResults,
    {
      presentation: presentationOf(state.case),
      diagnosis: state.diagnosis,
      procedureSteps: pending,
      outline: state.outline,
      userInstructions: userInstructionsForProcedures(state.userInstructions),
    },
    runtime?.context,
    `Error generating results for batch [${pending.map((p) => p.name).join(", ")}]`
  );

  const updatedProcedures = appendProcedures(
    state.case.procedures,
    completedProcedures
  );

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[ProcedureGraph] Results for batch of ${completedProcedures.length} procedure(s):\n\`\`\`json\n${JSON.stringify(completedProcedures, null, 2)}\n\`\`\``,
  });

  return new Command({
    update: {
      case: { procedures: updatedProcedures },
      pendingProcedures: [],
    },
    goto: "blinded_step",
  });
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
  presentation: Presentation,
  diagnosis: ProcedureGraphState["diagnosis"],
  previousProcedures: ProcedureResult[],
  userInstructions: string | undefined,
  context: RequestContext | undefined
): Promise<ProcedureResult[]> {
  const categories = await invokeLogged(
    procedureTools.generateBridgeCategoryStep,
    { presentation, diagnosis, previousProcedures, userInstructions },
    context,
    "Error in bridge category step"
  );

  const allCategories = procedureCatalog.categories();
  const selectedCategories = categories.length ? categories : allCategories;

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[ProcedureGraph] Bridge category step selected: [${selectedCategories.join(", ")}]${categories.length ? "" : " (fallback: all categories)"}`,
  });

  const scopedResults = await invokeLogged(
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

  bus.emit("Generation Log", {
    logLevel: "warn",
    timestamp: new Date().toISOString(),
    msg: `[ProcedureGraph] Bridge pick from [${selectedCategories.join(", ")}] returned no procedures — retrying with all categories.`,
  });

  return invokeLogged(
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

async function bridge(
  state: ProcedureGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Command> {
  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[ProcedureGraph] Generating bridge procedures to confirm diagnosis…`,
  });

  const presentation = presentationOf(state.case);
  const previousProcedures = state.case.procedures ?? [];
  const userInstructions = userInstructionsForProcedures(
    state.userInstructions
  );

  const bridgeProcedures = useSmallModelSplit()
    ? await resolveBridgeViaCategories(
        presentation,
        state.diagnosis,
        previousProcedures,
        userInstructions,
        runtime?.context
      )
    : await invokeLogged(
        procedureTools.generateDiagnosisBridge,
        {
          presentation,
          diagnosis: state.diagnosis,
          previousProcedures,
          userInstructions,
        },
        runtime?.context,
        "Error generating bridge procedures"
      );

  const updatedProcedures = appendProcedures(
    state.case.procedures,
    bridgeProcedures
  );

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[ProcedureGraph] Bridge complete — ${bridgeProcedures.length} procedure(s) added:\n\`\`\`json\n${JSON.stringify(bridgeProcedures, null, 2)}\n\`\`\``,
  });

  return new Command({
    update: { case: { procedures: updatedProcedures } },
    goto: END,
  });
}

// ─── Graph ────────────────────────────────────────────────────────────────────

export const procedureGraph = new StateGraph(
  ProcedureGraphStateSchema,
  RequestContextSchema
)
  .addNode(
    "blinded_step",
    traceNode("blinded_step", blindedStep, "Choosing next procedure"),
    { ends: ["result_step", "bridge", END] }
  )
  .addNode(
    "result_step",
    traceNode("result_step", resultStep, "Generating procedure result"),
    { ends: ["blinded_step"] }
  )
  .addNode(
    "bridge",
    traceNode("bridge", bridge, "Bridging workup to diagnosis"),
    { ends: [END] }
  )
  .addEdge(START, "blinded_step")
  .compile();
