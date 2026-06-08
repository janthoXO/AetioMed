import { END, START, StateGraph, type Runtime } from "@langchain/langgraph";
import { bus } from "@/core/graph/index.js";
import { CaseGenerationStateSchema } from "../state.js";
import z from "zod";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/core/graph/utils/context.js";
import { singleFieldCoTTools } from "./tools.js";
import { generationTools } from "../tools.js";
import { wrapNode } from "@/core/graph/utils/nodeWrapper.js";

const SingleFieldStateSchema = CaseGenerationStateSchema.extend({
  cot: z.string(),
});

type SingleFieldState = z.infer<typeof SingleFieldStateSchema>;

// ─── patient ──────────────────────────────────────────────────────────────────

async function generatePatientCoT(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "cot">> {
  bus.emit("Generation Log", {
    msg: `[SingleFieldGraph] Generating patient CoT…`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  const cot = await singleFieldCoTTools.generatePatientCoT
    .invoke(
      {
        diagnosis: state.diagnosis,
        symptoms: state.symptoms,
        userInstructions: state.userInstructions
          ? JSON.stringify(state.userInstructions)
          : undefined,
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        msg: `[SingleFieldGraph] Error generating patient CoT: ${error}`,
        logLevel: "error",
        timestamp: new Date().toISOString(),
      });
      throw error;
    });

  bus.emit("Generation Log", {
    msg: `[SingleFieldGraph] Patient CoT:\n${cot}`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  return { cot };
}

async function generatePatientField(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "case">> {
  bus.emit("Generation Log", {
    msg: "[SingleFieldGraph] Generating patient field…",
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  const patient = await generationTools.generatePatientFromCoT
    .invoke(
      {
        diagnosis: state.diagnosis,
        cot: state.cot,
        symptoms: state.symptoms,
        userInstructions: state.userInstructions
          ? JSON.stringify(state.userInstructions)
          : undefined,
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        msg: `[SingleFieldGraph] Error generating patient: ${error}`,
        logLevel: "error",
        timestamp: new Date().toISOString(),
      });
      throw error;
    });

  bus.emit("Generation Log", {
    msg: `[SingleFieldGraph] Patient generated:\n\`\`\`json\n${JSON.stringify(patient)}\n\`\`\``,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  return { case: { patient } };
}

// ─── chief complaint ──────────────────────────────────────────────────────────

async function generateChiefComplaintCoT(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "cot">> {
  bus.emit("Generation Log", {
    msg: `[SingleFieldGraph] Generating chief complaint CoT…`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  const cot = await singleFieldCoTTools.generateChiefComplaintCoT
    .invoke(
      {
        diagnosis: state.diagnosis,
        symptoms: state.symptoms,
        userInstructions: state.userInstructions
          ? JSON.stringify(state.userInstructions)
          : undefined,
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        msg: `[SingleFieldGraph] Error generating chief complaint CoT: ${error}`,
        logLevel: "error",
        timestamp: new Date().toISOString(),
      });
      throw error;
    });

  bus.emit("Generation Log", {
    msg: `[SingleFieldGraph] Chief complaint CoT:\n${cot}`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  return { cot };
}

async function generateChiefComplaintField(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "case">> {
  bus.emit("Generation Log", {
    msg: "[SingleFieldGraph] Generating chief complaint field…",
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  const chiefComplaint = await generationTools.generateChiefComplaintFromCoT
    .invoke(
      {
        diagnosis: state.diagnosis,
        cot: state.cot,
        symptoms: state.symptoms,
        userInstructions: state.userInstructions
          ? JSON.stringify(state.userInstructions)
          : undefined,
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        msg: `[SingleFieldGraph] Error generating chief complaint: ${error}`,
        logLevel: "error",
        timestamp: new Date().toISOString(),
      });
      throw error;
    });

  bus.emit("Generation Log", {
    msg: `[SingleFieldGraph] Chief complaint generated:\n${chiefComplaint}`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  return { case: { chiefComplaint } };
}

// ─── anamnesis ────────────────────────────────────────────────────────────────

async function generateAnamnesisCoT(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "cot">> {
  bus.emit("Generation Log", {
    msg: `[SingleFieldGraph] Generating anamnesis CoT…`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  const cot = await singleFieldCoTTools.generateAnamnesisCoT
    .invoke(
      {
        diagnosis: state.diagnosis,
        symptoms: state.symptoms,
        anamnesisCategories: state.anamnesisCategories,
        userInstructions: state.userInstructions
          ? JSON.stringify(state.userInstructions)
          : undefined,
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        msg: `[SingleFieldGraph] Error generating anamnesis CoT: ${error}`,
        logLevel: "error",
        timestamp: new Date().toISOString(),
      });
      throw error;
    });

  bus.emit("Generation Log", {
    msg: `[SingleFieldGraph] Anamnesis CoT:\n${cot}`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  return { cot };
}

async function generateAnamnesisField(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "case">> {
  bus.emit("Generation Log", {
    msg: "[SingleFieldGraph] Generating anamnesis field…",
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  const anamnesis = await generationTools.generateAnamnesisFromCoT
    .invoke(
      {
        diagnosis: state.diagnosis,
        cot: state.cot,
        symptoms: state.symptoms,
        anamnesisCategories: state.anamnesisCategories,
        userInstructions: state.userInstructions
          ? JSON.stringify(state.userInstructions)
          : undefined,
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        msg: `[SingleFieldGraph] Error generating anamnesis: ${error}`,
        logLevel: "error",
        timestamp: new Date().toISOString(),
      });
      throw error;
    });

  bus.emit("Generation Log", {
    msg: `[SingleFieldGraph] Anamnesis generated:\n\`\`\`json\n${JSON.stringify(anamnesis, null, 2)}\n\`\`\``,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  return { case: { anamnesis } };
}

// ─── procedures ───────────────────────────────────────────────────────────────

async function generateProceduresCoT(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "cot">> {
  bus.emit("Generation Log", {
    msg: `[SingleFieldGraph] Generating procedures CoT…`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  const cot = await singleFieldCoTTools.generateProceduresCoT
    .invoke(
      {
        diagnosis: state.diagnosis,
        symptoms: state.symptoms,
        userInstructions: state.userInstructions
          ? JSON.stringify(state.userInstructions)
          : undefined,
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        msg: `[SingleFieldGraph] Error generating procedures CoT: ${error}`,
        logLevel: "error",
        timestamp: new Date().toISOString(),
      });
      throw error;
    });

  bus.emit("Generation Log", {
    msg: `[SingleFieldGraph] Procedures CoT:\n${cot}`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  return { cot };
}

async function generateProceduresField(
  state: SingleFieldState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SingleFieldState, "case">> {
  bus.emit("Generation Log", {
    msg: "[SingleFieldGraph] Generating procedures field…",
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  const procedures = await generationTools.generateProceduresFromCoT
    .invoke(
      {
        diagnosis: state.diagnosis,
        cot: state.cot,
        symptoms: state.symptoms,
        userInstructions: state.userInstructions
          ? JSON.stringify(state.userInstructions)
          : undefined,
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        msg: `[SingleFieldGraph] Error generating procedures: ${error}`,
        logLevel: "error",
        timestamp: new Date().toISOString(),
      });
      throw error;
    });

  bus.emit("Generation Log", {
    msg: `[SingleFieldGraph] Procedures generated:\n\`\`\`json\n${JSON.stringify(procedures, null, 2)}\n\`\`\``,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  return { case: { procedures } };
}

// ─── graph ────────────────────────────────────────────────────────────────────

export const singleFieldGraph = new StateGraph(
  SingleFieldStateSchema,
  RequestContextSchema
)
  .addNode(
    "instructions_reduce",
    wrapNode("instructions_reduce", (state: SingleFieldState) => {
      if (!state.userInstructions) return {};
      return {
        userInstructions: Object.fromEntries(
          Object.entries(state.userInstructions).filter(
            ([key]) => key === state.generationFlags[0] || key === "general"
          )
        ),
      };
    })
  )
  .addNode("patient_cot", wrapNode("patient_cot", generatePatientCoT))
  .addNode(
    "patient_generate",
    wrapNode("patient_generate", generatePatientField)
  )
  .addNode(
    "chiefComplaint_cot",
    wrapNode("chiefComplaint_cot", generateChiefComplaintCoT)
  )
  .addNode(
    "chiefComplaint_generate",
    wrapNode("chiefComplaint_generate", generateChiefComplaintField)
  )
  .addNode("anamnesis_cot", wrapNode("anamnesis_cot", generateAnamnesisCoT))
  .addNode(
    "anamnesis_generate",
    wrapNode("anamnesis_generate", generateAnamnesisField)
  )
  .addNode("procedures_cot", wrapNode("procedures_cot", generateProceduresCoT))
  .addNode(
    "procedures_generate",
    wrapNode("procedures_generate", generateProceduresField)
  )

  .addEdge(START, "instructions_reduce")
  .addConditionalEdges(
    "instructions_reduce",
    (state) => {
      switch (state.generationFlags[0]) {
        case "patient":
          return "patient";
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
