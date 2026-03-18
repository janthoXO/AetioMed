import { END, Send, START, StateGraph } from "@langchain/langgraph";
import { GlobalStateSchema } from "../state.js";
import z from "zod";
import { InconsistencySchema } from "@/models/Inconsistency.js";
import { generateAnamnesisFromOutline } from "@/03aigateway/anamnesis.aigateway.js";
import { generateChiefComplaintFromOutline } from "@/03aigateway/chiefComplaint.aigateway.js";
import { generateInconsistenciesFromOutline } from "@/03aigateway/consistency.aigateway.js";
import { generateProceduresFromOutline } from "@/03aigateway/procedures.aigateway.js";
import { passthrough } from "@/02graphs/graph.utils.js";
import { emitTrace } from "@/utils/tracing.js";
import { generatePatientFromOutline } from "@/03aigateway/patient.aigateway.js";

const InconsistencyGraphStateSchema = GlobalStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  generationFlags: true,
  case: true,
  anamnesisCategories: true,
  outline: true,
}).extend({
  refinementIterationsRemaining: z.number().default(2),
  inconsistencies: z.array(InconsistencySchema).default([]),
});

type InconsistencyGraphState = z.infer<typeof InconsistencyGraphStateSchema>;

async function generateInconsistencies(
  state: InconsistencyGraphState
): Promise<Pick<InconsistencyGraphState, "inconsistencies">> {
  emitTrace("[InconsistencyGraph] Starting generation of inconsistencies...");
  state.inconsistencies = await generateInconsistenciesFromOutline(
    state.case,
    state.diagnosis,
    state.generationFlags,
    state.outline,
    state.userInstructions
  ).catch((error) => {
    emitTrace(
      `[InconsistencyGraph] Error generating inconsistencies: ${error}`,
      { category: "error" }
    );
    throw error;
  });

  // filter inconsistencies to only those relevant for the current generation flags
  state.inconsistencies = state.inconsistencies.filter((i) =>
    state.generationFlags.some((f) => f === i.field)
  );

  emitTrace(
    `[InconsistencyGraph] Successfully generated inconsistencies:\n${state.inconsistencies
      .map((i) => `- ${i.field}: ${i.description}`)
      .join("\n")}`
  );

  return { inconsistencies: state.inconsistencies };
}

async function refinePatient(
  state: InconsistencyGraphState
): Promise<Pick<InconsistencyGraphState, "case">> {
  emitTrace(`[InconsistencyGraph] Starting refinement of patient fields...`);
  state.case.patient = await generatePatientFromOutline(
    state.diagnosis,
    state.outline,
    state.userInstructions,
    state.case, // provide the case to allow refinement on "old" case data
    state.inconsistencies //these should already be filtered by the send logic
  ).catch((error) => {
    emitTrace(`[InconsistencyGraph] Error refining patient: ${error}`, {
      category: "error",
    });
    throw error;
  });

  emitTrace(
    `[InconsistencyGraph] Successfully refined patient: ${JSON.stringify(state.case.patient, null, 2)}`
  );

  throw new Error("Patient refinement not implemented yet");
}

async function refineChiefComplaint(
  state: InconsistencyGraphState
): Promise<Pick<InconsistencyGraphState, "case">> {
  emitTrace("[InconsistencyGraph] Starting refinement of chief complaint...");
  state.case.chiefComplaint = await generateChiefComplaintFromOutline(
    state.diagnosis,
    state.outline,
    state.userInstructions,
    state.case, // provide the case to allow refinement on "old" case data
    state.inconsistencies //these should already be filtered by the send logic
  ).catch((error) => {
    emitTrace(`[InconsistencyGraph] Error refining chief complaint: ${error}`, {
      category: "error",
    });
    throw error;
  });

  emitTrace(
    `[InconsistencyGraph] Successfully refined chief complaint: ${state.case.chiefComplaint}`
  );

  return {
    case: {
      chiefComplaint: state.case.chiefComplaint,
    },
  };
}

async function refineAnamnesis(
  state: InconsistencyGraphState
): Promise<Pick<InconsistencyGraphState, "case">> {
  emitTrace("[InconsistencyGraph] Starting refinement of anamnesis...");
  state.case.anamnesis = await generateAnamnesisFromOutline(
    state.diagnosis,
    state.outline,
    state.userInstructions,
    state.anamnesisCategories,
    state.case, // provide the case to allow refinement on "old" case data
    state.inconsistencies //these should already be filtered by the send logic
  ).catch((error) => {
    emitTrace(`[InconsistencyGraph] Error refining anamnesis: ${error}`, {
      category: "error",
    });
    throw error;
  });

  emitTrace(
    `[InconsistencyGraph] Successfully refined anamnesis: ${JSON.stringify(state.case.anamnesis, null, 2)}`
  );

  return {
    case: {
      anamnesis: state.case.anamnesis,
    },
  };
}

async function refineProcedures(
  state: InconsistencyGraphState
): Promise<Pick<InconsistencyGraphState, "case">> {
  emitTrace("[InconsistencyGraph] Starting refinement of procedures...");
  state.case.procedures = await generateProceduresFromOutline(
    state.diagnosis,
    state.outline,
    state.userInstructions,
    undefined, // no specified procedures will take the predefined ones.
    state.case, // provide the case to allow refinement on "old" case data
    state.inconsistencies //these should already be filtered by the send logic
  ).catch((error) => {
    emitTrace(`[InconsistencyGraph] Error refining procedures: ${error}`, {
      category: "error",
    });
    throw error;
  });

  emitTrace(
    `[InconsistencyGraph] Successfully refined procedures: ${JSON.stringify(state.case.procedures, null, 2)}`
  );

  return {
    case: {
      procedures: state.case.procedures,
    },
  };
}

export const inconsistencyGraph = new StateGraph(InconsistencyGraphStateSchema)
  .addNode("loop_entry", passthrough<InconsistencyGraphState>)
  .addNode("inconsistencies_generate", generateInconsistencies)
  .addNode("patient_refine", refinePatient)
  .addNode("chief_complaint_refine", refineChiefComplaint)
  .addNode("anamnesis_refine", refineAnamnesis)
  .addNode("procedures_refine", refineProcedures)
  .addNode("inconsistencies_none", () => {
    console.debug(
      "[InconsistencyGraph: inconsistencies_none] No inconsistencies found, ending refinement..."
    );
    // set iteration to 0 to break loop
    return {
      refinementIterationsRemaining: 0,
    };
  })
  .addNode("refinement_fan_in", (state) => {
    console.debug(
      "[InconsistencyGraph: refinement_fan_in] Decreasing refinement iterations remaining..."
    );
    state.refinementIterationsRemaining = Math.max(
      0,
      state.refinementIterationsRemaining - 1
    );
    return {
      refinementIterationsRemaining: state.refinementIterationsRemaining,
    };
  })

  .addEdge(START, "loop_entry")
  .addConditionalEdges(
    "loop_entry",
    (state) => {
      return state.refinementIterationsRemaining > 0 ? "continue" : "end";
    },
    {
      end: END,
      // inconsistencies generation should then decrease the iteration count
      continue: "inconsistencies_generate",
    }
  )
  .addConditionalEdges(
    "inconsistencies_generate",
    (state): Send[] => {
      if (state.inconsistencies.length < 1) {
        return [new Send("inconsistencies_none", state)];
      }

      const sends: Send[] = [];
      if (state.inconsistencies.some((i) => i.field === "patient")) {
        const filteredInconsistencies = state.inconsistencies.filter(
          (i) => i.field === "patient"
        );
        sends.push(
          new Send("patient_refine", {
            ...state,
            inconsistencies: filteredInconsistencies,
          })
        );
      }

      if (state.inconsistencies.some((i) => i.field === "chiefComplaint")) {
        const filteredInconsistencies = state.inconsistencies.filter(
          (i) => i.field === "chiefComplaint"
        );
        sends.push(
          new Send("chief_complaint_refine", {
            ...state,
            inconsistencies: filteredInconsistencies,
          })
        );
      }

      if (state.inconsistencies.some((i) => i.field === "anamnesis")) {
        const filteredInconsistencies = state.inconsistencies.filter(
          (i) => i.field === "anamnesis"
        );
        sends.push(
          new Send("anamnesis_refine", {
            ...state,
            inconsistencies: filteredInconsistencies,
          })
        );
      }

      if (state.inconsistencies.some((i) => i.field === "procedures")) {
        const filteredInconsistencies = state.inconsistencies.filter(
          (i) => i.field === "procedures"
        );
        sends.push(
          new Send("procedures_refine", {
            ...state,
            inconsistencies: filteredInconsistencies,
          })
        );
      }

      return sends;
    },
    [
      "patient_refine",
      "chief_complaint_refine",
      "anamnesis_refine",
      "procedures_refine",
      "inconsistencies_none",
    ]
  )
  .addEdge("patient_refine", "refinement_fan_in")
  .addEdge("chief_complaint_refine", "refinement_fan_in")
  .addEdge("anamnesis_refine", "refinement_fan_in")
  .addEdge("procedures_refine", "refinement_fan_in")
  .addEdge("inconsistencies_none", "refinement_fan_in")
  .addEdge("refinement_fan_in", "loop_entry")
  .compile();
