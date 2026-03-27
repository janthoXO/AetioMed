import { END, START, StateGraph, type Runtime } from "@langchain/langgraph";
import { GlobalStateSchema } from "../state.js";
import z from "zod";
import { RequestContextSchema, type RequestContext } from "@/utils/context.js";
import {
  generatePatientCoT as generatePatientCoTGateway,
  generatePatient as generatePatientGateway,
} from "@/03aigateway/patient.aigateway.js";
import {
  generateChiefComplaintCoT as generateChiefComplaintCoTGateway,
  generateChiefComplaint as generateChiefComplaintGateway,
} from "@/03aigateway/chiefComplaint.aigateway.js";
import {
  generateAnamnesisCoT as generateAnamnesisCoTGateway,
  generateAnamnesis as generateAnamnesisGateway,
} from "@/03aigateway/anamnesis.aigateway.js";
import {
  generateProceduresCoT as generateProceduresCoTGateway,
  generateProcedures as generateProceduresGateway,
} from "@/03aigateway/procedures.aigateway.js";

const SingleFieldStateSchema = GlobalStateSchema.extend({
  cot: z.string(),
});

type SingleFieldState = z.infer<typeof SingleFieldStateSchema>;

async function generatePatientCoT(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "cot">> {
  runtime?.context?.traceUtils?.emitTrace(
    `[SingleFieldGraph] Generating CoT for patient field...`
  );

  state.cot = await generatePatientCoTGateway(
    state.diagnosis,
    state.symptoms,
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
    runtime?.context?.traceUtils?.emitTrace(
      `[SingleFieldGraph] Error generating patient CoT: ${error}`,
      {
        category: "error",
      }
    );
    throw error;
  });

  runtime?.context?.traceUtils?.emitTrace(
    `[SingleFieldGraph] Generated CoT for patient field:
${state.cot}`
  );
  return { cot: state.cot };
}

async function generatePatientField(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "case">> {
  runtime?.context?.traceUtils?.emitTrace(
    "[SingleFieldGraph] Generating patient field..."
  );
  state.case.patient = await generatePatientGateway(
    state.diagnosis,
    {
      cot: state.cot,
      symptoms: state.symptoms,
    },
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
    runtime?.context?.traceUtils?.emitTrace(
      `[SingleFieldGraph] Error generating patient field: ${error}`,
      {
        category: "error",
      }
    );
    throw error;
  });

  runtime?.context?.traceUtils?.emitTrace(
    `[SingleFieldGraph] Generated patient field:
\`\`\`json
${state.case.patient}
\`\`\``
  );

  return { case: state.case };
}

async function generateChiefComplaintCoT(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "cot">> {
  runtime?.context?.traceUtils?.emitTrace(
    `[SingleFieldGraph] Generating CoT for chief complaint field...`
  );

  state.cot = await generateChiefComplaintCoTGateway(
    state.diagnosis,
    state.symptoms,
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
    runtime?.context?.traceUtils?.emitTrace(
      `[SingleFieldGraph] Error generating chief complaint CoT: ${error}`,
      {
        category: "error",
      }
    );
    throw error;
  });

  runtime?.context?.traceUtils?.emitTrace(
    `[SingleFieldGraph] Generated CoT for chief complaint field:
${state.cot}`
  );
  return { cot: state.cot };
}

async function generateChiefComplaintField(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "case">> {
  runtime?.context?.traceUtils?.emitTrace(
    "[SingleFieldGraph] Generating chief complaint field..."
  );
  state.case.chiefComplaint = await generateChiefComplaintGateway(
    state.diagnosis,
    {
      cot: state.cot,
      symptoms: state.symptoms,
    },
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
    runtime?.context?.traceUtils?.emitTrace(
      `[SingleFieldGraph] Error generating chief complaint field: ${error}`,
      {
        category: "error",
      }
    );
    throw error;
  });

  runtime?.context?.traceUtils?.emitTrace(
    `[SingleFieldGraph] Generated chief complaint field:
${state.case.chiefComplaint}`
  );

  return { case: state.case };
}

async function generateAnamnesisCoT(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "cot">> {
  runtime?.context?.traceUtils?.emitTrace(
    `[SingleFieldGraph] Generating CoT for anamnesis field...`
  );

  state.cot = await generateAnamnesisCoTGateway(
    state.diagnosis,
    state.symptoms,
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    state.anamnesisCategories,
    runtime?.context
  ).catch((error) => {
    runtime?.context?.traceUtils?.emitTrace(
      `[SingleFieldGraph] Error generating anamnesis CoT: ${error}`,
      {
        category: "error",
      }
    );
    throw error;
  });

  runtime?.context?.traceUtils?.emitTrace(
    `[SingleFieldGraph] Generated CoT for anamnesis field:
${state.cot}`
  );
  return { cot: state.cot };
}

async function generateAnamnesisField(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "case">> {
  runtime?.context?.traceUtils?.emitTrace(
    "[SingleFieldGraph] Generating anamnesis field..."
  );
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
    runtime?.context?.traceUtils?.emitTrace(
      `[SingleFieldGraph] Error generating anamnesis field: ${error}`,
      {
        category: "error",
      }
    );
    throw error;
  });

  runtime?.context?.traceUtils?.emitTrace(
    `[SingleFieldGraph] Generated anamnesis field:
\`\`\`json
${JSON.stringify(state.case.anamnesis, null, 2)}
\`\`\``
  );

  return { case: state.case };
}

async function generateProceduresCoT(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "cot">> {
  runtime?.context?.traceUtils?.emitTrace(
    `[SingleFieldGraph] Generating CoT for procedures field...`
  );

  state.cot = await generateProceduresCoTGateway(
    state.diagnosis,
    state.symptoms,
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
    runtime?.context?.traceUtils?.emitTrace(
      `[SingleFieldGraph] Error generating procedures CoT: ${error}`,
      {
        category: "error",
      }
    );
    throw error;
  });

  runtime?.context?.traceUtils?.emitTrace(
    `[SingleFieldGraph] Generated CoT for procedures field:
${state.cot}`
  );
  return { cot: state.cot };
}

async function generateProceduresField(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "case">> {
  runtime?.context?.traceUtils?.emitTrace(
    "[SingleFieldGraph] Generating procedures field..."
  );
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
    runtime?.context?.traceUtils?.emitTrace(
      `[SingleFieldGraph] Error generating procedures field: ${error}`,
      {
        category: "error",
      }
    );
    throw error;
  });

  runtime?.context?.traceUtils?.emitTrace(
    `[SingleFieldGraph] Generated procedures field:
\`\`\`json
${JSON.stringify(state.case.procedures, null, 2)}
\`\`\``
  );

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
