import {
  END,
  Send,
  START,
  StateGraph,
  type Runtime,
} from "@langchain/langgraph";
import { bus } from "@/core/graph/index.js";
import { CaseGenerationStateSchema } from "../../state.js";
import z from "zod";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/core/graph/utils/context.js";
import { passthrough } from "@/core/graph/02graphs/graph.utils.js";
import type { PickNested } from "@/core/graph/utils/pickNested.js";
import { fieldGenerationBlueprintTools } from "./tools.js";
import { generationTools } from "../../tools.js";
import { wrapNode } from "@/core/graph/utils/nodeWrapper.js";

const GenerationGraphStateSchema = CaseGenerationStateSchema.extend({
  cot: z.string(),
  outline: z.string(),
});

type GenerationGraphState = z.infer<typeof GenerationGraphStateSchema>;

// ─── blueprint nodes ──────────────────────────────────────────────────────────

async function generateCaseCoT(
  state: GenerationGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<GenerationGraphState, "cot">> {
  const cot = await fieldGenerationBlueprintTools.generateCaseCoT
    .invoke(
      {
        diagnosis: state.diagnosis,
        generationFlags: state.generationFlags,
        userInstructions: state.userInstructions
          ? JSON.stringify(state.userInstructions)
          : undefined,
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        logLevel: "error",
        timestamp: new Date().toISOString(),
        msg: `[GenerationGraph] Error generating case CoT: ${error}`,
      });
      throw error;
    });

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Case CoT generated:\n\`\`\` ${cot}\`\`\``,
  });
  return { cot };
}

async function generateCaseOutline(
  state: GenerationGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<GenerationGraphState, "outline">> {
  const outline = await fieldGenerationBlueprintTools.generateCaseOutline
    .invoke(
      {
        diagnosis: state.diagnosis,
        generationFlags: state.generationFlags,
        symptoms: state.symptoms,
        cot: state.cot,
        userInstructions: state.userInstructions
          ? JSON.stringify(state.userInstructions)
          : undefined,
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        logLevel: "error",
        timestamp: new Date().toISOString(),
        msg: `[GenerationGraph] Error generating case outline: ${error}`,
      });
      throw error;
    });

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Case outline generated:\n\`\`\` ${outline}\`\`\``,
  });
  return { outline };
}

// ─── fan-out field nodes ──────────────────────────────────────────────────────

type PatientNodeInput = Pick<
  GenerationGraphState,
  "diagnosis" | "outline" | "userInstructions"
>;

async function generatePatient(
  state: PatientNodeInput,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<GenerationGraphState, "case", "patient">> {
  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Generating patient…`,
  });
  const patient = await generationTools.generatePatientFromOutline
    .invoke(
      {
        diagnosis: state.diagnosis,
        outline: state.outline,
        userInstructions: state.userInstructions
          ? JSON.stringify(state.userInstructions)
          : undefined,
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        logLevel: "error",
        timestamp: new Date().toISOString(),
        msg: `[GenerationGraph] Error generating patient: ${error}`,
      });
      throw error;
    });

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Patient generated:\n\`\`\`json\n${JSON.stringify(patient, null, 2)}\n\`\`\``,
  });
  return { case: { patient } };
}

type ChiefComplaintNodeInput = Pick<
  GenerationGraphState,
  "diagnosis" | "outline" | "userInstructions"
>;

async function generateChiefComplaint(
  state: ChiefComplaintNodeInput,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<GenerationGraphState, "case", "chiefComplaint">> {
  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Generating chief complaint…`,
  });
  const chiefComplaint = await generationTools.generateChiefComplaintFromOutline
    .invoke(
      {
        diagnosis: state.diagnosis,
        outline: state.outline,
        userInstructions: state.userInstructions
          ? JSON.stringify(state.userInstructions)
          : undefined,
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        logLevel: "error",
        timestamp: new Date().toISOString(),
        msg: `[GenerationGraph] Error generating chief complaint: ${error}`,
      });
      throw error;
    });

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Chief complaint generated:\n\`\`\` ${chiefComplaint}\`\`\``,
  });
  return { case: { chiefComplaint } };
}

type AnamnesisNodeInput = Pick<
  GenerationGraphState,
  "diagnosis" | "outline" | "anamnesisCategories" | "userInstructions"
>;

async function generateAnamnesis(
  state: AnamnesisNodeInput,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<GenerationGraphState, "case", "anamnesis">> {
  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Generating anamnesis…`,
  });
  const anamnesis = await generationTools.generateAnamnesisFromOutline
    .invoke(
      {
        diagnosis: state.diagnosis,
        outline: state.outline,
        anamnesisCategories: state.anamnesisCategories,
        userInstructions: state.userInstructions
          ? JSON.stringify(state.userInstructions)
          : undefined,
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        logLevel: "error",
        timestamp: new Date().toISOString(),
        msg: `[GenerationGraph] Error generating anamnesis: ${error}`,
      });
      throw error;
    });

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Anamnesis generated:\n\`\`\`json\n${JSON.stringify(anamnesis, null, 2)}\n\`\`\``,
  });
  return { case: { anamnesis } };
}

async function generateProcedures(
  state: GenerationGraphState,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<GenerationGraphState, "case", "procedures">> {
  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Generating procedures…`,
  });
  const procedures = await generationTools.generateProceduresFromCase
    .invoke(
      {
        diagnosis: state.diagnosis,
        case: state.case,
        userInstructions: state.userInstructions
          ? JSON.stringify(
              Object.fromEntries(
                Object.entries(state.userInstructions).filter(
                  ([key]) => key === "procedures" || key === "general"
                )
              )
            )
          : undefined,
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        logLevel: "error",
        timestamp: new Date().toISOString(),
        msg: `[GenerationGraph] Error generating procedures: ${error}`,
      });
      throw error;
    });

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Procedures generated:\n\`\`\`json\n${JSON.stringify(procedures, null, 2)}\n\`\`\``,
  });
  return { case: { procedures } };
}

// ─── graph ────────────────────────────────────────────────────────────────────

export const fieldGenerationGraph = new StateGraph(
  GenerationGraphStateSchema,
  RequestContextSchema
)
  .addNode("case_cot_generate", wrapNode("case_cot_generate", generateCaseCoT))
  .addNode(
    "case_outline_generate",
    wrapNode("case_outline_generate", generateCaseOutline)
  )
  .addNode("patient_generate", wrapNode("patient_generate", generatePatient))
  .addNode(
    "chief_complaint_generate",
    wrapNode("chief_complaint_generate", generateChiefComplaint)
  )
  .addNode(
    "anamnesis_generate",
    wrapNode("anamnesis_generate", generateAnamnesis)
  )
  .addNode(
    "case_fan_in",
    wrapNode("case_fan_in", passthrough<GenerationGraphState>)
  )
  .addNode(
    "procedures_generate",
    wrapNode("procedures_generate", generateProcedures)
  )

  .addEdge(START, "case_cot_generate")
  .addEdge("case_cot_generate", "case_outline_generate")
  .addConditionalEdges(
    "case_outline_generate",
    (state): Send[] => {
      const sends: Send[] = [];

      const filterInstructions = (keys: string[]) =>
        state.userInstructions
          ? Object.fromEntries(
              Object.entries(state.userInstructions).filter(([k]) =>
                keys.includes(k)
              )
            )
          : undefined;

      if (state.generationFlags.includes("patient")) {
        sends.push(
          new Send("patient_generate", {
            diagnosis: state.diagnosis,
            outline: state.outline,
            userInstructions: filterInstructions(["patient", "general"]),
          })
        );
      }
      if (state.generationFlags.includes("chiefComplaint")) {
        sends.push(
          new Send("chief_complaint_generate", {
            diagnosis: state.diagnosis,
            outline: state.outline,
            userInstructions: filterInstructions(["chiefComplaint", "general"]),
          })
        );
      }
      if (state.generationFlags.includes("anamnesis")) {
        sends.push(
          new Send("anamnesis_generate", {
            diagnosis: state.diagnosis,
            outline: state.outline,
            anamnesisCategories: state.anamnesisCategories,
            userInstructions: filterInstructions(["anamnesis", "general"]),
          })
        );
      }

      return sends;
    },
    ["patient_generate", "chief_complaint_generate", "anamnesis_generate"]
  )
  .addEdge("patient_generate", "case_fan_in")
  .addEdge("chief_complaint_generate", "case_fan_in")
  .addEdge("anamnesis_generate", "case_fan_in")
  .addConditionalEdges(
    "case_fan_in",
    (state) =>
      state.generationFlags.includes("procedures") ? "generate" : "skip",
    { generate: "procedures_generate", skip: END }
  )
  .addEdge("procedures_generate", END)
  .compile();
