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
  ProcedureResultSchema,
  type ProcedureResult,
} from "@/core/graph/models/Procedure.js";
import type { Case } from "@/core/graph/models/Case.js";
import { textOf } from "@/core/graph/models/ContentPart.js";
import { procedureTools, PresentationSchema } from "./tools.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { renderUserInstructions } from "@/core/graph/utils/prompt.js";
import type { Presentation } from "@/core/graph/03aigateway/procedures.aigateway.js";
import type { Tool } from "@/core/graph/utils/tool.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { ProcedureStrategy, SolverMove } from "./strategy/ports.js";

// ─── State ────────────────────────────────────────────────────────────────────

const SOLVER_MAX_ITERATIONS = 6;

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

/**
 * The blinded solver's own compiled graph, whose state schema **omits
 * `diagnosis` entirely**. `BlindedView` (`strategy/ports.ts`) already makes
 * passing the diagnosis into the blinded path a compile error — that is the
 * primary defence, and is what actually matters. This compiled child graph
 * is a *runtime* backstop on top of it, not a topology decision: LangGraph
 * filters input against a graph's state schema before it ever reaches a
 * channel (`@langchain/langgraph/dist/pregel/io.js:81`), so a `diagnosis`
 * key would be silently dropped here even if a future edit mistakenly
 * widened `BlindedView` to carry one — the guarantee survives that edit,
 * the type alone would not.
 *
 * It exists for its input schema, not for topology: it is `.invoke()`d
 * directly from inside `blinded_step`, never `addNode`'d, so the compiled
 * procedure graph below still has exactly three nodes.
 */
const BlindedSolverStateSchema = z.object({
  presentation: PresentationSchema,
  previousProcedures: z.array(ProcedureResultSchema).default([]),
  ruledOutDiagnoses: z.array(z.string()).default([]),
  userInstructions: z.string().optional(),
  iterationsRemaining: z.number(),
  /** Output-only: the strategy's decision, set by the graph's single node. */
  move: z.custom<SolverMove>().optional(),
});

/**
 * Exported for `index.test.ts` only, to assert the runtime filtering
 * guarantee directly (not just the `BlindedView` type) — production code
 * never calls this outside `buildProcedureGraph`.
 */
export function buildBlindedSolverGraph(strategy: ProcedureStrategy) {
  return new StateGraph(BlindedSolverStateSchema, RequestContextSchema)
    .addNode("solve", async (state, lgRuntime?: Runtime<RequestContext>) => {
      const move = await strategy.nextStep({
        presentation: state.presentation,
        previousProcedures: state.previousProcedures,
        ruledOutDiagnoses: state.ruledOutDiagnoses,
        userInstructions: state.userInstructions,
        iterationsRemaining: state.iterationsRemaining,
        context: lgRuntime?.context,
      });
      return { move };
    })
    .addEdge(START, "solve")
    .addEdge("solve", END)
    .compile();
}

type BlindedSolverGraph = ReturnType<typeof buildBlindedSolverGraph>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the presentation slice (no diagnosis, no procedures) from the
 * case, projected to text via `textOf` — bytes must never reach a prompt
 * (issue 11 §4), and `Presentation`'s own fields are `string`, not
 * `ContentPart[]`, so this is the one place that conversion happens.
 */
function presentationOf(c: Case): Presentation {
  return {
    ...(c.patient !== undefined && { patient: c.patient }),
    ...(c.chiefComplaint !== undefined && {
      chiefComplaint: textOf(c.chiefComplaint),
    }),
    ...(c.anamnesis !== undefined && {
      anamnesis: c.anamnesis.map((a) => ({
        category: a.category,
        answer: textOf(a.answer),
      })),
    }),
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
 * Propagates the parent's request context to the child blinded-solver
 * graph's `.invoke()` — the same shape `02graphs/caseGraph.ts`'s
 * `generateCase` uses to invoke the top-level graph.
 */
function childInvokeConfig(context: RequestContext | undefined) {
  return {
    context: { llmConfig: context?.llmConfig, jobId: context?.jobId },
    ...(context?.signal !== undefined ? { signal: context.signal } : {}),
  };
}

// ─── Node 1: blinded_step ─────────────────────────────────────────────────────

function makeBlindedStep(
  runtime: GraphRuntime,
  blindedSolverGraph: BlindedSolverGraph
) {
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

    // Builds the child input from state — there is no `diagnosis` field to
    // pass, by construction (see `BlindedSolverStateSchema` above).
    const { move: rawMove } = await blindedSolverGraph.invoke(
      {
        presentation,
        previousProcedures,
        ruledOutDiagnoses: state.ruledOutDiagnoses,
        userInstructions,
        iterationsRemaining: state.solverIterationsRemaining,
      },
      childInvokeConfig(lgRuntime?.context)
    );
    // Defensive fallback only — the child graph's single node always
    // returns a move from a well-typed `ProcedureStrategy`.
    const move: SolverMove = rawMove ?? {
      action: "exhausted",
      reason: "unexpected shape",
    };

    runtime.log.info(
      `[ProcedureGraph] Blinded step (${state.solverIterationsRemaining} iter left):\n\`\`\`json\n${JSON.stringify(move, null, 2)}\n\`\`\``
    );

    // ── action: order a batch of mutually-independent procedures ───────────────
    if (move.action === "order") {
      return new Command({
        update: {
          pendingProcedures: move.procedures,
          solverIterationsRemaining: state.solverIterationsRemaining - 1,
        },
        goto: "result_step",
      });
    }

    // ── action: commit to a diagnosis ──────────────────────────────────────────
    if (move.action === "diagnose") {
      return handleDiagnoseAction(
        runtime,
        state,
        lgRuntime,
        move.diagnosisName
      );
    }

    // ── action: exhausted — `reason` distinguishes an empty pick (the
    // solver had nothing left worth ordering, a clinically sensible reason
    // to bridge, logged at info) from an unexpected response shape (a real
    // symptom of a misbehaving model, logged at warn) ──────────────────────
    if (move.reason === "unexpected shape") {
      runtime.log.warn(
        `[ProcedureGraph] Blinded step returned unexpected shape — bridging.`
      );
    } else {
      runtime.log.info(
        `[ProcedureGraph] Blinded step returned an empty pick — bridging to diagnosis.`
      );
    }
    return new Command({ goto: "bridge" });
  };
}

/** Shared diagnose-action handling for `blinded_step` (either strategy). */
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

function makeBridge(runtime: GraphRuntime, strategy: ProcedureStrategy) {
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

    const bridgeProcedures = await strategy.bridge({
      presentation,
      diagnosis: state.diagnosis,
      previousProcedures,
      userInstructions,
      context: lgRuntime?.context,
    });

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
  strategy: ProcedureStrategy,
  traceNode: ReturnType<typeof createTraceNode>
) {
  const blindedSolverGraph = buildBlindedSolverGraph(strategy);

  return new StateGraph(ProcedureGraphStateSchema, RequestContextSchema)
    .addNode(
      "blinded_step",
      traceNode(
        "blinded_step",
        makeBlindedStep(runtime, blindedSolverGraph),
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
        makeBridge(runtime, strategy),
        "Bridging workup to diagnosis"
      ),
      { ends: [END] }
    )
    .addEdge(START, "blinded_step")
    .compile();
}
