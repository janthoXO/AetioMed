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
  PlannedProcedureSchema,
  ProcedureRelevanceSchema,
  ProcedureSchema,
  type PlannedProcedure,
} from "@/core/graph/models/Procedure.js";
import type { Case } from "@/core/graph/models/Case.js";
import { textOf } from "@/core/graph/models/ContentPart.js";
import { procedureTools, PresentationSchema } from "./tools.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { renderUserInstructions } from "@/core/graph/utils/prompt.js";
import {
  planProcedureResults,
  type Presentation,
  type PreviousProcedureFinding,
} from "@/core/graph/03aigateway/procedures.aigateway.js";
import type { Tool } from "@/core/graph/utils/tool.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type {
  ModalityPlan,
  ModalityProvider,
} from "@/core/graph/modality/ports.js";
import { renderPlan } from "@/core/graph/modality/pipeline.js";
import { EmptyModalityRegistryError } from "@/core/graph/modality/registry.js";
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
   * scheduled together and awaiting their planned result.
   */
  pendingProcedures: z.array(ProcedureSchema).default([]),
  /**
   * Procedures decided so far, planned not rendered. Writers: `result_step`,
   * `bridge`. `render_results` reads, then writes `case.procedures` (empty
   * until then). Blinded view, already-ordered exclusion and bridge view all
   * read this, not `case.procedures`.
   */
  plannedProcedures: z.array(PlannedProcedureSchema).default([]),
  /** Diagnoses committed to and ruled out in earlier iterations. */
  ruledOutDiagnoses: z.array(z.string()).default([]),
});

type ProcedureGraphState = z.infer<typeof ProcedureGraphStateSchema>;

// Mounted as `procedure_phase`. `.pick()` off own state schema so `case` keeps
// its reducer registration.
const ProcedureOutputSchema = ProcedureGraphStateSchema.pick({ case: true });

/**
 * Blinded solver's child graph; state schema omits `diagnosis`. `BlindedView`
 * (`strategy/ports.ts`) is the compile-time guard; this is the runtime
 * backstop: LangGraph drops input keys not in the state schema. `.invoke()`d
 * from `blinded_step`, never `addNode`'d — exists for its input schema.
 */
const BlindedSolverStateSchema = z.object({
  presentation: PresentationSchema,
  // Projected from `plannedProcedures`; nothing rendered yet. See
  // `PreviousProcedureFinding`.
  previousProcedures: z
    .array(
      z.object({
        name: z.string(),
        relevance: ProcedureRelevanceSchema,
        result: z.string(),
      })
    )
    .default([]),
  ruledOutDiagnoses: z.array(z.string()).default([]),
  userInstructions: z.string().optional(),
  iterationsRemaining: z.number(),
  /** Output-only: the strategy's decision, set by the graph's single node. */
  move: z.custom<SolverMove>().optional(),
});

/** Exported for `index.test.ts` only. */
export function buildBlindedSolverGraph(strategy: ProcedureStrategy) {
  return new StateGraph(BlindedSolverStateSchema, {
    context: RequestContextSchema,
    // Write surface declared explicitly; `move` is the only output.
    output: BlindedSolverStateSchema.pick({ move: true }),
  })
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

/** Presentation slice (no diagnosis, no procedures), text-projected via `textOf`; bytes never reach a prompt. */
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

/**
 * Projects `plannedProcedures` to blinded/bridge prior-procedure view:
 * `result` = parts' `alt` joined, never bytes. Single source for
 * `previousProcedures` and, via the aigateway, already-ordered exclusion.
 */
function projectPreviousProcedures(
  plannedProcedures: PlannedProcedure[]
): PreviousProcedureFinding[] {
  return plannedProcedures.map((p) => ({
    name: p.name,
    relevance: p.relevance,
    result: p.parts.map((part) => part.alt).join("\n\n"),
  }));
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

/**
 * Read-and-concat append on a `LastValue` channel. Safe only because
 * `result_step` and `bridge` are sequential: one writer per superstep. If
 * fanned out (`Send`, parallel branches), use a concat reducer or appends
 * clobber each other.
 */
function appendPlannedProcedures(
  current: PlannedProcedure[] | undefined,
  incoming: PlannedProcedure[]
): PlannedProcedure[] {
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

/** Propagates parent request context to the child blinded-solver `.invoke()`. */
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
    const previousProcedures = projectPreviousProcedures(
      state.plannedProcedures
    );
    const userInstructions = userInstructionsForProcedures(
      state.userInstructions
    );

    // No `diagnosis` field to pass, by construction.
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
    // Defensive fallback only.
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

    // ── action: exhausted — empty pick logs info; unexpected shape (misbehaving model) logs warn ──
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
    // Nothing rendered yet; `render_results` renders all, then graph ends.
    return new Command({ goto: "render_results" });
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

function makeResultStep(
  runtime: GraphRuntime,
  providers: ModalityProvider<unknown>[]
) {
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

    // Plans results, does not render. `providers` not zod-validatable, so no
    // `Tool` wrapper.
    const plannedBatch: PlannedProcedure[] = await planProcedureResults(
      runtime,
      presentationOf(state.case),
      state.diagnosis,
      pending,
      providers,
      state.outline,
      userInstructionsForProcedures(state.userInstructions),
      lgRuntime?.context
    ).catch((error) => {
      runtime.log.error(
        `[ProcedureGraph] Error planning results for batch [${pending.map((p) => p.name).join(", ")}]: ${error}`
      );
      throw error;
    });

    const updatedProcedures = appendPlannedProcedures(
      state.plannedProcedures,
      plannedBatch
    );

    runtime.log.info(
      `[ProcedureGraph] Planned results for batch of ${plannedBatch.length} procedure(s):\n\`\`\`json\n${JSON.stringify(plannedBatch, null, 2)}\n\`\`\``
    );

    return new Command({
      update: {
        plannedProcedures: updatedProcedures,
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
      `[ProcedureGraph] Planning bridge procedures to confirm diagnosis…`
    );

    const presentation = presentationOf(state.case);
    const previousProcedures = projectPreviousProcedures(
      state.plannedProcedures
    );
    const userInstructions = userInstructionsForProcedures(
      state.userInstructions
    );

    // `strategy.bridge()` picks confirmatory procedures and plans their results; no rendering.
    const bridgeProcedures = await strategy.bridge({
      presentation,
      diagnosis: state.diagnosis,
      previousProcedures,
      userInstructions,
      context: lgRuntime?.context,
    });

    const updatedProcedures = appendPlannedProcedures(
      state.plannedProcedures,
      bridgeProcedures
    );

    runtime.log.info(
      `[ProcedureGraph] Bridge complete — ${bridgeProcedures.length} procedure(s) planned:\n\`\`\`json\n${JSON.stringify(bridgeProcedures, null, 2)}\n\`\`\``
    );

    return new Command({
      update: { plannedProcedures: updatedProcedures },
      goto: "render_results",
    });
  };
}

// ─── Node 4: render_results ───────────────────────────────────────────────────

function makeRenderResults(
  runtime: GraphRuntime,
  providers: ModalityProvider<unknown>[]
) {
  return async function renderResults(
    state: ProcedureGraphState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Command> {
    // One `ModalityPlan` for all procedures, keyed by index not name (names
    // can collide after translation). One `renderPlan` call = one batch, one LLM call.
    const plan: ModalityPlan = Object.fromEntries(
      state.plannedProcedures.map((p, i) => [String(i), p.parts])
    );

    const rendered = await renderPlan(
      providers,
      plan,
      lgRuntime?.context,
      runtime.log
    );

    const procedures = state.plannedProcedures.map((p, i) => ({
      name: p.name,
      relevance: p.relevance,
      result: rendered[String(i)]!,
    }));

    runtime.log.info(
      `[ProcedureGraph] Rendered ${procedures.length} procedure result(s).`
    );

    return new Command({
      update: { case: { procedures } },
      goto: END,
    });
  };
}

// ─── Graph ────────────────────────────────────────────────────────────────────

export function buildProcedureGraph(
  runtime: GraphRuntime,
  strategy: ProcedureStrategy,
  providers: ModalityProvider<unknown>[],
  traceNode: ReturnType<typeof createTraceNode>
) {
  if (providers.length === 0) {
    throw new EmptyModalityRegistryError();
  }

  const blindedSolverGraph = buildBlindedSolverGraph(strategy);

  return new StateGraph(ProcedureGraphStateSchema, {
    context: RequestContextSchema,
    output: ProcedureOutputSchema,
  })
    .addNode(
      "blinded_step",
      traceNode(
        "blinded_step",
        makeBlindedStep(runtime, blindedSolverGraph),
        "Choosing next procedure"
      ),
      { ends: ["result_step", "bridge", "render_results"] }
    )
    .addNode(
      "result_step",
      traceNode(
        "result_step",
        makeResultStep(runtime, providers),
        "Planning procedure results"
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
      { ends: ["render_results"] }
    )
    .addNode(
      "render_results",
      traceNode(
        "render_results",
        makeRenderResults(runtime, providers),
        "Rendering procedure results"
      ),
      { ends: [END] }
    )
    .addEdge(START, "blinded_step")
    .compile();
}
