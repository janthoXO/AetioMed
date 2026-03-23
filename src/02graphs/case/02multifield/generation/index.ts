import { END, Send, START, StateGraph } from "@langchain/langgraph";
import { GlobalStateSchema } from "../../state.js";
import z from "zod";
import { generateChiefComplaint as generateChiefComplaintGateway } from "@/03aigateway/chiefComplaint.aigateway.js";
import {
  generateCaseCoT as generateCaseCoTGateway,
  generateCaseOutline as generateCaseOutlineGateway,
} from "@/03aigateway/case.aigateway.js";
import { emitTrace } from "@/utils/tracing.js";
import { generatePatient as generatePatientGateway } from "@/03aigateway/patient.aigateway.js";
import { generateAnamnesis as generateAnamnesisGateway } from "@/03aigateway/anamnesis.aigateway.js";
import { generateProcedures as generateProceduresGateway } from "@/03aigateway/procedures.aigateway.js";
import { passthrough } from "@/02graphs/graph.utils.js";

const GenerationGraphStateSchema = GlobalStateSchema.extend({
  cot: z.string(),

  /**
   * Generated outline for the case.
   */
  outline: z.string(),
});

type GenerationGraphState = z.infer<typeof GenerationGraphStateSchema>;

async function generateCaseCoT(
  state: GenerationGraphState
): Promise<Pick<GenerationGraphState, "cot">> {
  state.cot = await generateCaseCoTGateway(
    state.diagnosis,
    state.generationFlags,
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined
  ).catch((error) => {
    emitTrace(`[GenerationGraph] Error generating case CoT: ${error}`, {
      category: "error",
    });
    throw error;
  });

  emitTrace(`[GenerationGraph] Successfully generated case CoT:
${state.cot}`);

  return { cot: state.cot };
}

async function generateCaseOutline(
  state: GenerationGraphState
): Promise<Pick<GenerationGraphState, "outline">> {
  state.outline = await generateCaseOutlineGateway(
    state.diagnosis,
    state.generationFlags,
    state.symptoms,
    state.cot,
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined
  ).catch((error) => {
    emitTrace(`[GenerationGraph] Error generating case outline: ${error}`, {
      category: "error",
    });
    throw error;
  });

  emitTrace(
    `[GenerationGraph] Successfully generated case outline:
${state.outline}`
  );

  return { outline: state.outline };
}

async function generatePatient(state: GenerationGraphState) {
  emitTrace(`[GenerationGraph] Starting generation of patient fields...`);
  state.case.patient = await generatePatientGateway(
    state.diagnosis,
    {
      outline: state.outline,
    },
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined
  ).catch((error) => {
    emitTrace(`[GenerationGraph] Error generating patient: ${error}`, {
      category: "error",
    });
    throw error;
  });

  emitTrace(
    `[GenerationGraph] Successfully generated patient:
\`\`\`json
${JSON.stringify(state.case.patient, null, 2)}
\`\`\``
  );

  return { case: state.case };
}

async function generateChiefComplaint(
  state: GenerationGraphState
): Promise<Pick<GenerationGraphState, "case">> {
  emitTrace(`[GenerationGraph] Starting generation of chief complaint...`);
  state.case.chiefComplaint = await generateChiefComplaintGateway(
    state.diagnosis,
    {
      outline: state.outline,
    },
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined
  ).catch((error) => {
    emitTrace(`[GenerationGraph] Error generating chief complaint: ${error}`, {
      category: "error",
    });
    throw error;
  });

  emitTrace(
    `[GenerationGraph] Successfully generated chief complaint:
${state.case.chiefComplaint}`
  );

  return { case: state.case };
}

async function generateAnamnesis(state: GenerationGraphState) {
  emitTrace(`[GenerationGraph] Starting generation of anamnesis fields...`);
  state.case.anamnesis = await generateAnamnesisGateway(
    state.diagnosis,
    {
      outline: state.outline,
    },
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    state.anamnesisCategories
  ).catch((error) => {
    emitTrace(`[GenerationGraph] Error generating anamnesis: ${error}`, {
      category: "error",
    });
    throw error;
  });

  emitTrace(
    `[GenerationGraph] Successfully generated anamnesis:
\`\`\`json
${JSON.stringify(state.case.anamnesis, null, 2)}
\`\`\``
  );

  return { case: state.case };
}

async function generateProcedures(state: GenerationGraphState) {
  emitTrace(`[GenerationGraph] Starting generation of procedures...`);
  state.case.procedures = await generateProceduresGateway(
    state.diagnosis,
    {
      outline: state.outline,
      case: state.case,
    },
    state.userInstructions
      ? JSON.stringify(
          Object.entries(state.userInstructions).filter(
            ([key]) => key === "procedures" || key === "general"
          )
        )
      : undefined
  ).catch((error) => {
    emitTrace(`[GenerationGraph] Error generating procedures: ${error}`, {
      category: "error",
    });
    throw error;
  });

  emitTrace(
    `[GenerationGraph] Successfully generated procedures:
\`\`\`json
${JSON.stringify(state.case.procedures, null, 2)}
\`\`\``
  );

  return { case: state.case };
}

export const generationGraph = new StateGraph(GenerationGraphStateSchema)
  .addNode("case_cot_generate", generateCaseCoT)
  .addNode("case_outline_generate", generateCaseOutline)
  .addNode("patient_generate", generatePatient)
  .addNode("chief_complaint_generate", generateChiefComplaint)
  .addNode("anamnesis_generate", generateAnamnesis)
  .addNode("case_checkpoint", passthrough<GenerationGraphState>)
  .addNode("procedures_generate", generateProcedures)

  .addEdge(START, "case_cot_generate")
  .addEdge("case_cot_generate", "case_outline_generate")
  .addConditionalEdges(
    "case_outline_generate",
    (state): Send[] => {
      const sends: Send[] = [];

      if (state.generationFlags.includes("patient")) {
        sends.push(
          new Send("patient_generate", {
            ...state,
            userInstructions: state.userInstructions
              ? Object.entries(state.userInstructions).filter(
                  ([key]) => key === "patient" || key === "general"
                )
              : undefined,
          })
        );
      }
      if (state.generationFlags.includes("chiefComplaint")) {
        sends.push(
          new Send("chief_complaint_generate", {
            ...state,
            userInstructions: state.userInstructions
              ? Object.entries(state.userInstructions).filter(
                  ([key]) => key === "chiefComplaint" || key === "general"
                )
              : undefined,
          })
        );
      }
      if (state.generationFlags.includes("anamnesis")) {
        sends.push(
          new Send("anamnesis_generate", {
            ...state,
            userInstructions: state.userInstructions
              ? Object.entries(state.userInstructions).filter(
                  ([key]) => key === "anamnesis" || key === "general"
                )
              : undefined,
          })
        );
      }

      return sends;
    },
    ["patient_generate", "chief_complaint_generate", "anamnesis_generate"]
  )
  .addEdge("patient_generate", "case_checkpoint")
  .addEdge("chief_complaint_generate", "case_checkpoint")
  .addEdge("anamnesis_generate", "case_checkpoint")
  .addConditionalEdges(
    "case_checkpoint",
    (state) => {
      if (state.generationFlags.includes("procedures")) {
        return "generate";
      }
      return "skip";
    },
    {
      generate: "procedures_generate",
      skip: END,
    }
  )
  .addEdge("procedures_generate", END)
  .compile();
