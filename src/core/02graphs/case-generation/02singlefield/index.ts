import { END, START, StateGraph, type Runtime } from "@langchain/langgraph";
import { publishEvent } from "@/core/eventBus/index.js";
import { CaseGenerationStateSchema } from "../state.js";
import z from "zod";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/core/utils/context.js";
import {
  generatePatientCoT as generatePatientCoTGateway,
  generatePatient as generatePatientGateway,
} from "@/core/03aigateway/patient.aigateway.js";
import {
  generateChiefComplaintCoT as generateChiefComplaintCoTGateway,
  generateChiefComplaint as generateChiefComplaintGateway,
} from "@/core/03aigateway/chiefComplaint.aigateway.js";
import {
  generateAnamnesisCoT as generateAnamnesisCoTGateway,
  generateAnamnesis as generateAnamnesisGateway,
} from "@/core/03aigateway/anamnesis.aigateway.js";
import {
  generateProceduresCoT as generateProceduresCoTGateway,
  generateProcedures as generateProceduresGateway,
} from "@/core/03aigateway/procedures.aigateway.js";

const SingleFieldStateSchema = CaseGenerationStateSchema.extend({
  cot: z.string(),
});

type SingleFieldState = z.infer<typeof SingleFieldStateSchema>;

async function generatePatientCoT(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "cot">> {
  publishEvent("Generation Log", {
    msg: `[SingleFieldGraph] Generating CoT for patient field...`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  state.cot = await generatePatientCoTGateway(
    state.diagnosis,
    state.symptoms,
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
    publishEvent("Generation Log", {
      msg: `[SingleFieldGraph] Error generating patient CoT: ${error}`,
      logLevel: "error",
      timestamp: new Date().toISOString(),
    });
    throw error;
  });

  publishEvent("Generation Log", {
    msg: `[SingleFieldGraph] Generated CoT for patient field:\n${state.cot}`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  return { cot: state.cot };
}

async function generatePatientField(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "case">> {
  publishEvent("Generation Log", {
    msg: "[SingleFieldGraph] Generating patient field...",
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  state.case.patient = await generatePatientGateway(
    state.diagnosis,
    {
      cot: state.cot,
      symptoms: state.symptoms,
    },
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
    publishEvent("Generation Log", {
      msg: `[SingleFieldGraph] Error generating patient field: ${error}`,
      logLevel: "error",
      timestamp: new Date().toISOString(),
    });
    throw error;
  });

  publishEvent("Generation Log", {
    msg: `[SingleFieldGraph] Generated patient field:\n\`\`\`json\n${state.case.patient}\n\`\`\``,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  return { case: state.case };
}

async function generateChiefComplaintCoT(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "cot">> {
  publishEvent("Generation Log", {
    msg: `[SingleFieldGraph] Generating CoT for chief complaint field...`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  state.cot = await generateChiefComplaintCoTGateway(
    state.diagnosis,
    state.symptoms,
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
    publishEvent("Generation Log", {
      msg: `[SingleFieldGraph] Error generating chief complaint CoT: ${error}`,
      logLevel: "error",
      timestamp: new Date().toISOString(),
    });
    throw error;
  });

  publishEvent("Generation Log", {
    msg: `[SingleFieldGraph] Generated CoT for chief complaint field:\n${state.cot}`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  return { cot: state.cot };
}

async function generateChiefComplaintField(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "case">> {
  publishEvent("Generation Log", {
    msg: "[SingleFieldGraph] Generating chief complaint field...",
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  state.case.chiefComplaint = await generateChiefComplaintGateway(
    state.diagnosis,
    {
      cot: state.cot,
      symptoms: state.symptoms,
    },
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
    publishEvent("Generation Log", {
      msg: `[SingleFieldGraph] Error generating chief complaint field: ${error}`,
      logLevel: "error",
      timestamp: new Date().toISOString(),
    });
    throw error;
  });

  publishEvent("Generation Log", {
    msg: `[SingleFieldGraph] Generated chief complaint field:\n${state.case.chiefComplaint}`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  return { case: state.case };
}

async function generateAnamnesisCoT(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "cot">> {
  publishEvent("Generation Log", {
    msg: `[SingleFieldGraph] Generating CoT for anamnesis field...`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  state.cot = await generateAnamnesisCoTGateway(
    state.diagnosis,
    state.symptoms,
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    state.anamnesisCategories,
    runtime?.context
  ).catch((error) => {
    publishEvent("Generation Log", {
      msg: `[SingleFieldGraph] Error generating anamnesis CoT: ${error}`,
      logLevel: "error",
      timestamp: new Date().toISOString(),
    });
    throw error;
  });

  publishEvent("Generation Log", {
    msg: `[SingleFieldGraph] Generated CoT for anamnesis field:\n${state.cot}`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  return { cot: state.cot };
}

async function generateAnamnesisField(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "case">> {
  publishEvent("Generation Log", {
    msg: "[SingleFieldGraph] Generating anamnesis field...",
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  state.case.anamnesis = await generateAnamnesisGateway(
    state.diagnosis,
    {
      cot: state.cot,
      symptoms: state.symptoms,
    },
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    state.anamnesisCategories,
    runtime?.context
  ).catch((error) => {
    publishEvent("Generation Log", {
      msg: `[SingleFieldGraph] Error generating anamnesis field: ${error}`,
      logLevel: "error",
      timestamp: new Date().toISOString(),
    });
    throw error;
  });

  publishEvent("Generation Log", {
    msg: `[SingleFieldGraph] Generated anamnesis field:\n\`\`\`json\n${JSON.stringify(state.case.anamnesis, null, 2)}\n\`\`\``,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  return { case: state.case };
}

async function generateProceduresCoT(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "cot">> {
  publishEvent("Generation Log", {
    msg: `[SingleFieldGraph] Generating CoT for procedures field...`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  state.cot = await generateProceduresCoTGateway(
    state.diagnosis,
    state.symptoms,
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
    publishEvent("Generation Log", {
      msg: `[SingleFieldGraph] Error generating procedures CoT: ${error}`,
      logLevel: "error",
      timestamp: new Date().toISOString(),
    });
    throw error;
  });

  publishEvent("Generation Log", {
    msg: `[SingleFieldGraph] Generated CoT for procedures field:\n${state.cot}`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  return { cot: state.cot };
}

async function generateProceduresField(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "case">> {
  publishEvent("Generation Log", {
    msg: "[SingleFieldGraph] Generating procedures field...",
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  state.case.procedures = await generateProceduresGateway(
    state.diagnosis,
    {
      cot: state.cot,
      symptoms: state.symptoms,
    },
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    undefined,
    runtime?.context
  ).catch((error) => {
    publishEvent("Generation Log", {
      msg: `[SingleFieldGraph] Error generating procedures field: ${error}`,
      logLevel: "error",
      timestamp: new Date().toISOString(),
    });
    throw error;
  });

  publishEvent("Generation Log", {
    msg: `[SingleFieldGraph] Generated procedures field:\n\`\`\`json\n${JSON.stringify(state.case.procedures, null, 2)}\n\`\`\``,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  return { case: state.case };
}

export const singleFieldGraph = new StateGraph(
  SingleFieldStateSchema,
  RequestContextSchema
)
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
