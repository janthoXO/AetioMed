import {
  Command,
  END,
  START,
  StateGraph,
  type Runtime,
} from "@langchain/langgraph";
import { bus } from "@/core/graph/index.js";
import { CaseGenerationStateSchema } from "../state.js";
import z from "zod";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/core/graph/utils/context.js";
import {
  PredefinedProcedureNames,
  ProcedureStepSchema,
  type Procedure,
} from "@/core/graph/models/Procedure.js";
import type { Case } from "@/core/graph/models/Case.js";
import { procedureTools } from "./tools.js";
import { traceNode } from "@/core/graph/utils/nodeWrapper.js";
import type { Presentation } from "@/core/graph/03aigateway/procedureSolver.aigateway.js";

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
  /** The procedure chosen by the blinded step, awaiting its result. */
  pendingProcedure: ProcedureStepSchema.optional(),
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
  return JSON.stringify(filtered);
}

/** Read-and-concat append: returns the full updated procedures array. */
function appendProcedures(
  current: Procedure[] | undefined,
  incoming: Procedure[]
): Procedure[] {
  return [...(current ?? []), ...incoming];
}

// ─── Node 1: blinded_step ─────────────────────────────────────────────────────

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

  const step = await procedureTools.generateBlindedProcedureStep
    .invoke(
      {
        presentation: presentationOf(state.case),
        previousProcedures: state.case.procedures ?? [],
        ruledOutDiagnoses: state.ruledOutDiagnoses,
        procedureNameList: PredefinedProcedureNames,
        userInstructions: userInstructionsForProcedures(state.userInstructions),
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        logLevel: "error",
        timestamp: new Date().toISOString(),
        msg: `[ProcedureGraph] Error in blinded step: ${error}`,
      });
      throw error;
    });

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[ProcedureGraph] Blinded step (${state.solverIterationsRemaining} iter left):\n\`\`\`json\n${JSON.stringify(step, null, 2)}\n\`\`\``,
  });

  // ── action: order a procedure ──────────────────────────────────────────────
  if (step.action === "procedure" && step.procedure) {
    return new Command({
      update: {
        pendingProcedure: step.procedure,
        solverIterationsRemaining: state.solverIterationsRemaining - 1,
      },
      goto: "result_step",
    });
  }

  // ── action: commit to a diagnosis ──────────────────────────────────────────
  if (step.action === "diagnose" && step.diagnosisName) {
    const matches = await procedureTools.matchDiagnosis
      .invoke(
        { proposedName: step.diagnosisName, diagnosis: state.diagnosis },
        runtime?.context
      )
      .catch((error) => {
        bus.emit("Generation Log", {
          logLevel: "error",
          timestamp: new Date().toISOString(),
          msg: `[ProcedureGraph] Error matching diagnosis: ${error}`,
        });
        throw error;
      });

    bus.emit("Generation Log", {
      logLevel: "info",
      timestamp: new Date().toISOString(),
      msg: `[ProcedureGraph] Diagnosis "${step.diagnosisName}" → ${matches ? "✓ match — done" : "✗ no match — continuing"}`,
    });

    if (matches) {
      return new Command({ goto: END });
    }

    // Wrong guess: feed it back as ruled-out and keep solving.
    return new Command({
      update: {
        ruledOutDiagnoses: [...state.ruledOutDiagnoses, step.diagnosisName],
        solverIterationsRemaining: state.solverIterationsRemaining - 1,
      },
      goto: "blinded_step",
    });
  }

  // Unexpected response shape — fall back to bridge.
  bus.emit("Generation Log", {
    logLevel: "warn",
    timestamp: new Date().toISOString(),
    msg: `[ProcedureGraph] Blinded step returned unexpected shape — bridging.`,
  });
  return new Command({ goto: "bridge" });
}

// ─── Node 2: result_step ──────────────────────────────────────────────────────

async function resultStep(
  state: ProcedureGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Command> {
  const pending = state.pendingProcedure;
  if (!pending) {
    // Guard: should not happen in normal flow.
    bus.emit("Generation Log", {
      logLevel: "warn",
      timestamp: new Date().toISOString(),
      msg: `[ProcedureGraph] result_step called without a pending procedure — skipping.`,
    });
    return new Command({ goto: "blinded_step" });
  }

  const result = await procedureTools.generateProcedureResult
    .invoke(
      {
        presentation: presentationOf(state.case),
        diagnosis: state.diagnosis,
        procedureStep: pending,
        outline: state.outline,
        userInstructions: userInstructionsForProcedures(state.userInstructions),
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        logLevel: "error",
        timestamp: new Date().toISOString(),
        msg: `[ProcedureGraph] Error generating result for "${pending.name}": ${error}`,
      });
      throw error;
    });

  const completedProcedure: Procedure = { ...pending, result };
  const updatedProcedures = appendProcedures(
    state.case.procedures,
    [completedProcedure]
  );

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[ProcedureGraph] Result for "${pending.name}": ${result}`,
  });

  return new Command({
    update: { case: { procedures: updatedProcedures } },
    goto: "blinded_step",
  });
}

// ─── Node 3: bridge ───────────────────────────────────────────────────────────

async function bridge(
  state: ProcedureGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Command> {
  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[ProcedureGraph] Generating bridge procedures to confirm diagnosis…`,
  });

  const bridgeProcedures = await procedureTools.generateDiagnosisBridge
    .invoke(
      {
        presentation: presentationOf(state.case),
        diagnosis: state.diagnosis,
        previousProcedures: state.case.procedures ?? [],
        procedureNameList: PredefinedProcedureNames,
        userInstructions: userInstructionsForProcedures(state.userInstructions),
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        logLevel: "error",
        timestamp: new Date().toISOString(),
        msg: `[ProcedureGraph] Error generating bridge procedures: ${error}`,
      });
      throw error;
    });

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
