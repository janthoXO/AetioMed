import {
  END,
  Send,
  START,
  StateGraph,
  type Runtime,
} from "@langchain/langgraph";
import { publishEvent } from "@/core/eventBus/index.js";
import { CaseGenerationStateSchema } from "../../state.js";
import z from "zod";
import { InconsistencySchema } from "@/core/models/Inconsistency.js";
import { generateAnamnesis } from "@/core/03aigateway/anamnesis.aigateway.js";
import { generateChiefComplaint } from "@/core/03aigateway/chiefComplaint.aigateway.js";
import { generateInconsistenciesFromOutline } from "@/core/03aigateway/consistency.aigateway.js";
import { generateProcedures } from "@/core/03aigateway/procedures.aigateway.js";
import { passthrough } from "@/core/02graphs/graph.utils.js";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/core/utils/context.js";
import { generatePatient } from "@/core/03aigateway/patient.aigateway.js";
import type { PickNested } from "@/core/utils/pickNested.js";

const InconsistencyGraphStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  generationFlags: true,
  case: true,
  anamnesisCategories: true,
}).extend({
  refinementIterationsRemaining: z.number().default(2),
  inconsistencies: z.array(InconsistencySchema).default([]),
});

type InconsistencyGraphState = z.infer<typeof InconsistencyGraphStateSchema>;

async function generateInconsistencies(
  state: InconsistencyGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<InconsistencyGraphState, "inconsistencies">> {
  publishEvent("Generation Log", {
    msg: "[InconsistencyGraph] Starting generation of inconsistencies...",
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  let generatedInconsistencies = await generateInconsistenciesFromOutline(
    state.case,
    state.diagnosis,
    state.generationFlags,
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
    publishEvent("Generation Log", {
      msg: `[InconsistencyGraph] Error generating inconsistencies: ${error}`,
      logLevel: "error",
      timestamp: new Date().toISOString(),
    });
    throw error;
  });

  // filter inconsistencies to only those relevant for the current generation flags
  generatedInconsistencies = generatedInconsistencies.filter((i) =>
    state.generationFlags.some((f) => f === i.field)
  );

  publishEvent("Generation Log", {
    msg: `[InconsistencyGraph] Successfully generated inconsistencies:\n${generatedInconsistencies
      .map((i) => `- ${i.field}: ${i.description}`)
      .join("\n")}`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  return { inconsistencies: generatedInconsistencies };
}

async function refinePatient(
  state: InconsistencyGraphState,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<InconsistencyGraphState, "case", "patient">> {
  publishEvent("Generation Log", {
    msg: `[InconsistencyGraph] Starting refinement of patient fields...`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  const generatedPatient = await generatePatient(
    state.diagnosis,
    {
      case: state.case, // provide the case to allow refinement on "old" case data
      inconsistencies: state.inconsistencies, //these should already be filtered by the send logic to fit only patient generation
    },
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
    publishEvent("Generation Log", {
      msg: `[InconsistencyGraph] Error refining patient: ${error}`,
      logLevel: "error",
      timestamp: new Date().toISOString(),
    });
    throw error;
  });

  publishEvent("Generation Log", {
    msg: `[InconsistencyGraph] Successfully refined patient:\n\`\`\`json\n${JSON.stringify(generatedPatient, null, 2)}\n\`\`\``,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  return { case: { patient: generatedPatient } };
}

async function refineChiefComplaint(
  state: InconsistencyGraphState,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<InconsistencyGraphState, "case", "chiefComplaint">> {
  publishEvent("Generation Log", {
    msg: "[InconsistencyGraph] Starting refinement of chief complaint...",
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  const generatedChiefComplaint = await generateChiefComplaint(
    state.diagnosis,
    {
      case: state.case, // provide the case to allow refinement on "old" case data
      inconsistencies: state.inconsistencies, //these should already be filtered by the send logic
    },
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
    publishEvent("Generation Log", {
      msg: `[InconsistencyGraph] Error refining chief complaint: ${error}`,
      logLevel: "error",
      timestamp: new Date().toISOString(),
    });
    throw error;
  });

  publishEvent("Generation Log", {
    msg: `[InconsistencyGraph] Successfully refined chief complaint:\n\`\`\`json\n${JSON.stringify(generatedChiefComplaint, null, 2)}\n\`\`\``,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  return {
    case: {
      chiefComplaint: generatedChiefComplaint,
    },
  };
}

async function refineAnamnesis(
  state: InconsistencyGraphState,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<InconsistencyGraphState, "case", "anamnesis">> {
  publishEvent("Generation Log", {
    msg: "[InconsistencyGraph] Starting refinement of anamnesis...",
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  const generatedAnamnesis = await generateAnamnesis(
    state.diagnosis,
    {
      case: state.case, // provide the case to allow refinement on "old" case data
      inconsistencies: state.inconsistencies, //these should already be filtered by the send logic
    },
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    state.anamnesisCategories,
    runtime?.context
  ).catch((error) => {
    publishEvent("Generation Log", {
      msg: `[InconsistencyGraph] Error refining anamnesis: ${error}`,
      logLevel: "error",
      timestamp: new Date().toISOString(),
    });
    throw error;
  });

  publishEvent("Generation Log", {
    msg: `[InconsistencyGraph] Successfully refined anamnesis:\n\`\`\`json\n${JSON.stringify(generatedAnamnesis, null, 2)}\n\`\`\``,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  return {
    case: {
      anamnesis: generatedAnamnesis,
    },
  };
}

async function refineProcedures(
  state: InconsistencyGraphState,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<InconsistencyGraphState, "case", "procedures">> {
  publishEvent("Generation Log", {
    msg: "[InconsistencyGraph] Starting refinement of procedures...",
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  const generatedProcedures = await generateProcedures(
    state.diagnosis,
    {
      case: state.case, // provide the case to allow refinement on "old" case data
      inconsistencies: state.inconsistencies, //these should already be filtered by the send logic
    },
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    undefined,
    runtime?.context
  ).catch((error) => {
    publishEvent("Generation Log", {
      msg: `[InconsistencyGraph] Error refining procedures: ${error}`,
      logLevel: "error",
      timestamp: new Date().toISOString(),
    });
    throw error;
  });

  publishEvent("Generation Log", {
    msg: `[InconsistencyGraph] Successfully refined procedures:\n\`\`\`json\n${JSON.stringify(generatedProcedures, null, 2)}\n\`\`\``,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  return {
    case: {
      procedures: generatedProcedures,
    },
  };
}

export const inconsistencyGraph = new StateGraph(
  InconsistencyGraphStateSchema,
  RequestContextSchema
)
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
        sends.push(
          new Send("patient_refine", {
            ...state,
            inconsistencies: state.inconsistencies.filter(
              (i) => i.field === "patient"
            ),
            userInstructions: state.userInstructions
              ? Object.entries(state.userInstructions).filter(
                  ([key]) => key === "patient" || key === "general"
                )
              : "",
          })
        );
      }

      if (state.inconsistencies.some((i) => i.field === "chiefComplaint")) {
        sends.push(
          new Send("chief_complaint_refine", {
            ...state,
            inconsistencies: state.inconsistencies.filter(
              (i) => i.field === "chiefComplaint"
            ),
            userInstructions: state.userInstructions
              ? Object.entries(state.userInstructions).filter(
                  ([key]) => key === "chiefComplaint" || key === "general"
                )
              : "",
          })
        );
      }

      if (state.inconsistencies.some((i) => i.field === "anamnesis")) {
        sends.push(
          new Send("anamnesis_refine", {
            ...state,
            inconsistencies: state.inconsistencies.filter(
              (i) => i.field === "anamnesis"
            ),
            userInstructions: state.userInstructions
              ? Object.entries(state.userInstructions).filter(
                  ([key]) => key === "anamnesis" || key === "general"
                )
              : "",
          })
        );
      }

      if (state.inconsistencies.some((i) => i.field === "procedures")) {
        sends.push(
          new Send("procedures_refine", {
            ...state,
            inconsistencies: state.inconsistencies.filter(
              (i) => i.field === "procedures"
            ),
            userInstructions: state.userInstructions
              ? Object.entries(state.userInstructions).filter(
                  ([key]) => key === "procedures" || key === "general"
                )
              : "",
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
