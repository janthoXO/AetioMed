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
   * Every procedure decided on so far, planned but not yet rendered (issue
   * 21 §7): `result_step` and `bridge` are the only writers, `render_results`
   * is the only reader-and-drain, and `case.procedures` stays EMPTY until
   * `render_results` writes it — the same single-writer discipline
   * `translate_merge` uses in the translation phase (issue 12). Every read
   * that used to go through `state.case.procedures` inside this graph —
   * the blinded view's `previousProcedures`, the already-ordered exclusion,
   * the bridge's own view — now goes through this instead.
   */
  plannedProcedures: z.array(PlannedProcedureSchema).default([]),
  /** Diagnoses committed to and ruled out in earlier iterations. */
  ruledOutDiagnoses: z.array(z.string()).default([]),
});

type ProcedureGraphState = z.infer<typeof ProcedureGraphStateSchema>;

// This graph is `addNode`'d into `buildCaseGenerationGraph` as
// `procedure_phase` (issue 17 §1). `.pick()` off this graph's own state
// schema, not a hand-written duplicate, so the picked `case` channel keeps
// the identical reducer registration.
const ProcedureOutputSchema = ProcedureGraphStateSchema.pick({ case: true });

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
 * procedure graph below still has exactly four nodes.
 */
const BlindedSolverStateSchema = z.object({
  presentation: PresentationSchema,
  // `{name, relevance, result: string}[]` (issue 21 §7), projected from
  // `plannedProcedures` — never the domain `ProcedureResult[]` this used to
  // be, since nothing has been rendered yet at this point in the loop. See
  // `03aigateway/procedures.aigateway.ts`'s `PreviousProcedureFinding`.
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

/**
 * Exported for `index.test.ts` only, to assert the runtime filtering
 * guarantee directly (not just the `BlindedView` type) — production code
 * never calls this outside `buildProcedureGraph`.
 */
export function buildBlindedSolverGraph(strategy: ProcedureStrategy) {
  return new StateGraph(BlindedSolverStateSchema, {
    context: RequestContextSchema,
    // `.invoke()`d directly from `blinded_step`, not `addNode`'d — but the
    // same rule applies regardless of mount style (issue 17 §1): declare the
    // write surface explicitly rather than letting it default to the whole
    // state. `move` is the only field this graph's single node produces.
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

/**
 * Projects `plannedProcedures` into the blinded/bridge view of a prior
 * procedure (issue 21 §7): `result` is `parts.map(p => p.alt).join("\n\n")`
 * — never rendered bytes, since nothing has been rendered yet at this point
 * in the loop. This is the ONE place that projection happens; every reader
 * that used to read `state.case.procedures` inside this graph reads this
 * instead (`blinded_step`'s and `bridge`'s `previousProcedures`, and —
 * transitively, via `.map(p => p.name)` inside the aigateway — the
 * already-ordered exclusion that makes duplicate orders impossible by
 * construction).
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
 * Read-and-concat append: returns the full updated planned-procedures array.
 *
 * Safe only because `result_step` and `bridge` are sequential nodes in this
 * graph — each superstep has exactly one writer of `plannedProcedures`, so a
 * read-modify-write on this `LastValue` channel never races another node's
 * write in the same step (issue 17 §2c). That is correct by accident of
 * topology, not by design: if this ever gets fanned out (`Send`, parallel
 * branches), the channel needs a concat reducer instead of `LastValue`, or
 * concurrent writers will silently clobber each other's appends exactly like
 * the bug this issue fixes elsewhere.
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
    const previousProcedures = projectPreviousProcedures(
      state.plannedProcedures
    );
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
    // Nothing has been rendered yet (issue 21 §7) — `render_results` renders
    // every planned procedure at once, THEN the graph ends.
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

    // PLANS results — does not render them (issue 21 §7). `providers` is not
    // zod-validatable data, so this is called directly rather than through a
    // `Tool` wrapper, mirroring the presentation fields' planner gateways
    // (`chiefComplaint/index.ts`'s `planChiefComplaint`).
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

    // `strategy.bridge()` both picks the confirmatory procedures AND plans
    // their results (issue 21 §7) — nothing is rendered here either.
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
    // Every planned part across EVERY procedure, flattened into one
    // `ModalityPlan` keyed by INDEX, not name (issue 21 §7): two procedures
    // can share a name after translation (issue 12's stable-path keying
    // reasoning applies identically here), and the name is translated
    // separately. One `renderPlan` call for the whole list is what makes
    // this cheap — the text provider sees every procedure's instruction in
    // a single batch and answers in one LLM call.
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
