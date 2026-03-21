import { END, START, StateGraph } from "@langchain/langgraph";
import { GlobalStateSchema } from "../state.js";
import z from "zod";
import { emitTrace } from "@/utils/tracing.js";
import type { Patient } from "@/models/Patient.js";
import type { ChiefComplaint } from "@/models/ChiefComplaint.js";

const SingleFieldStateSchema = GlobalStateSchema.extend({
  cot: z.string(),
});

type SingleFieldState = z.infer<typeof SingleFieldStateSchema>;

function generatePatientCoT(
  state: SingleFieldState
): Pick<SingleFieldState, "cot"> {
  emitTrace(`[SingleFieldGraph] Generating CoT for patient field...`);

  state.cot = "";

  emitTrace(
    `[SingleFieldGraph] Generated CoT for patient field:
${state.cot}`
  );
  return { cot: state.cot };
}

async function generatePatientField(
  state: SingleFieldState
): Promise<Pick<SingleFieldState, "case">> {
  emitTrace("[SingleFieldGraph] Generating patient field...");
  state.case.patient = {} as Patient;

  emitTrace(
    `[SingleFieldGraph] Generated patient field:
\`\`\`json
${state.case.patient}
\`\`\``
  );

  return { case: state.case };
}

function generateChiefComplaintCoT(
  state: SingleFieldState
): Pick<SingleFieldState, "cot"> {
  emitTrace(`[SingleFieldGraph] Generating CoT for chief complaint field...`);

  state.cot = "";

  emitTrace(
    `[SingleFieldGraph] Generated CoT for chief complaint field:
${state.cot}`
  );
  return { cot: state.cot };
}

async function generateChiefComplaintField(
  state: SingleFieldState
): Promise<Pick<SingleFieldState, "case">> {
  emitTrace("[SingleFieldGraph] Generating chief complaint field...");
  state.case.chiefComplaint = {} as ChiefComplaint;

  emitTrace(
    `[SingleFieldGraph] Generated chief complaint field:
${state.case.chiefComplaint}`
  );

  return { case: state.case };
}

function generateAnamnesisCoT(
  state: SingleFieldState
): Pick<SingleFieldState, "cot"> {
  emitTrace(`[SingleFieldGraph] Generating CoT for anamnesis field...`);

  state.cot = "";

  emitTrace(
    `[SingleFieldGraph] Generated CoT for anamnesis field:
${state.cot}`
  );
  return { cot: state.cot };
}

async function generateAnamnesisField(
  state: SingleFieldState
): Promise<Pick<SingleFieldState, "case">> {
  emitTrace("[SingleFieldGraph] Generating anamnesis field...");
  state.case.anamnesis = [];

  emitTrace(
    `[SingleFieldGraph] Generated anamnesis field:
\`\`\`json
${JSON.stringify(state.case.anamnesis, null, 2)}
\`\`\``
  );

  return { case: state.case };
}

function generateProceduresCoT(
  state: SingleFieldState
): Pick<SingleFieldState, "cot"> {
  emitTrace(`[SingleFieldGraph] Generating CoT for procedures field...`);

  state.cot = "";

  emitTrace(
    `[SingleFieldGraph] Generated CoT for procedures field:
${state.cot}`
  );
  return { cot: state.cot };
}

function generateProceduresField(
  state: SingleFieldState
): Pick<SingleFieldState, "case"> {
  emitTrace("[SingleFieldGraph] Generating procedures field...");
  state.case.procedures = [];

  emitTrace(
    `[SingleFieldGraph] Generated procedures field:
\`\`\`json
${JSON.stringify(state.case.procedures, null, 2)}
\`\`\``
  );

  return { case: state.case };
}

export const singleFieldGraph = new StateGraph(SingleFieldStateSchema)
  .addNode("instructions_reduce", (state) => {
    if (!state.userInstructions) {
      return {};
    }

    // filter out all instructions except the one of the generation flag and general
    const relevantInstructions = Object.entries(state.userInstructions).filter(
      ([key]) => key === state.generationFlags[0] || key === "general"
    );

    return {
      userInstructions: Object.fromEntries(relevantInstructions),
    };
  })
  .addNode("patient_cot", generatePatientCoT)
  .addNode("patient_generate", generatePatientField)
  .addNode("chiefComplaint_cot", generateChiefComplaintCoT)
  .addNode("chiefComplaint_generate", generateChiefComplaintField)
  .addNode("anamnesis_cot", generateAnamnesisCoT)
  .addNode("anamnesis_generate", generateAnamnesisField)
  .addNode("procedures_cot", generateProceduresCoT)
  .addNode("procedures_generate", generateProceduresField)

  .addEdge(START, "instructions_reduce")
  .addConditionalEdges(
    "instructions_reduce",
    (state) => {
      switch (state.generationFlags[0]) {
        case "patient": // generation flag name
          return "patient"; // routing key specified below
        case "chiefComplaint":
          return "chiefComplaint";
        case "anamnesis":
          return "anamnesis";
        case "procedures":
          return "procedures";
        default:
          throw new Error(
            `Invalid generation flag: ${state.generationFlags[0]}`
          );
      }
    },
    {
      patient: "patient_cot",
      chiefComplaint: "chiefComplaint_cot",
      anamnesis: "anamnesis_cot",
      procedures: "procedures_cot",
    }
  )
  .addEdge("patient_cot", "patient_generate")
  .addEdge("patient_generate", END)
  .addEdge("chiefComplaint_cot", "chiefComplaint_generate")
  .addEdge("chiefComplaint_generate", END)
  .addEdge("anamnesis_cot", "anamnesis_generate")
  .addEdge("anamnesis_generate", END)
  .addEdge("procedures_cot", "procedures_generate")
  .addEdge("procedures_generate", END)
  .compile();
