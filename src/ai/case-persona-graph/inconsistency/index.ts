import { END, Send, START, StateGraph } from "@langchain/langgraph";
import { GlobalStateSchema } from "../state.js";
import z from "zod";
import { InconsistencySchema } from "@/domain-models/Inconsistency.js";
import { generateAnamnesisOneShot } from "@/services/anamnesis.service.js";
import { generateChiefComplaintOneShot } from "@/services/chiefComplaint.service.js";
import { generateInconsistenciesOneShot } from "@/services/consistency.service.js";

const InconsistencyGraphStateSchema = GlobalStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  case: true,
  symptoms: true,
  refinementIterationsRemaining: true,
  anamnesisCategories: true,
}).extend({
  inconsistencies: z.array(InconsistencySchema).default([]),
});

type InconsistencyGraphState = z.infer<typeof InconsistencyGraphStateSchema>;

async function generateInconsistencies(
  state: InconsistencyGraphState
): Promise<InconsistencyGraphState> {
  console.debug(
    "[InconsistencyGraph: generateInconsistencies] Generating inconsistencies with LLM..."
  );
  state.inconsistencies = await generateInconsistenciesOneShot(
    state.case,
    state.diagnosis,
    state.symptoms,
    state.userInstructions
  );

  return state;
}

async function refineChiefComplaint(
  state: InconsistencyGraphState
): Promise<InconsistencyGraphState> {
  console.debug(
    "[InconsistencyGraph: refineChiefComplaint] Refining chief complaint with LLM..."
  );
  state.case.chiefComplaint = await generateChiefComplaintOneShot(
    state.diagnosis,
    state.symptoms,
    undefined,
    state.userInstructions,
    state.case.chiefComplaint,
    state.inconsistencies //these should already be filtered by the send logic
  );

  return state;
}

async function refineAnamnesis(
  state: InconsistencyGraphState
): Promise<InconsistencyGraphState> {
  console.debug(
    "[InconsistencyGraph: refineAnamnesis] Refining anamnesis with LLM..."
  );
  state.case.anamnesis = await generateAnamnesisOneShot(
    state.diagnosis,
    state.symptoms,
    undefined,
    state.userInstructions,
    state.anamnesisCategories,
    state.case.anamnesis,
    state.inconsistencies //these should already be filtered by the send logic
  );

  return state;
}

export const inconsistencyGraph = new StateGraph(InconsistencyGraphStateSchema)
  .addNode("inconsistencies_generate", generateInconsistencies)
  .addNode("chief_complaint_refine", refineChiefComplaint)
  .addNode("anamnesis_refine", refineAnamnesis)
  .addNode("inconsistencies_none", (state) => {
    console.debug(
      "[InconsistencyGraph: inconsistencies_none] No inconsistencies found, ending refinement..."
    );
    // set iteration to 0 to break loop
    return {
      ...state,
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
    return state;
  })

  .addEdge(START, "inconsistencies_generate")
  .addConditionalEdges(
    "inconsistencies_generate",
    (state): Send[] => {
      if (state.inconsistencies.length < 1) {
        return [new Send("inconsistencies_none", state)];
      }

      const sends: Send[] = [];
      if (state.inconsistencies.some((i) => i.field === "chiefComplaint")) {
        const filteredInconsistencies = state.inconsistencies.filter(
          (i) => i.field !== "chiefComplaint"
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
          (i) => i.field !== "anamnesis"
        );
        sends.push(
          new Send("anamnesis_refine", {
            ...state,
            inconsistencies: filteredInconsistencies,
          })
        );
      }
      return sends;
    },
    ["chief_complaint_refine", "anamnesis_refine", "inconsistencies_none"]
  )
  .addEdge("chief_complaint_refine", "refinement_fan_in")
  .addEdge("anamnesis_refine", "refinement_fan_in")
  .addEdge("inconsistencies_none", "refinement_fan_in")
  .addEdge("refinement_fan_in", END)
  .compile();
