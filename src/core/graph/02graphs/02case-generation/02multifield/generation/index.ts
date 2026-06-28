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
import { traceNode } from "@/core/graph/utils/nodeWrapper.js";

const GenerationGraphStateSchema = CaseGenerationStateSchema.extend({
  outline: z.string(),
});

type GenerationGraphState = z.infer<typeof GenerationGraphStateSchema>;

// ─── blueprint node ───────────────────────────────────────────────────────────

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

// ─── graph ────────────────────────────────────────────────────────────────────

export const fieldGenerationGraph = new StateGraph(
  GenerationGraphStateSchema,
  RequestContextSchema
)
  .addNode(
    "case_outline_generate",
    traceNode(
      "case_outline_generate",
      generateCaseOutline,
      "Generating case outline"
    )
  )
  .addNode(
    "patient_generate",
    traceNode("patient_generate", generatePatient, "Generating patient")
  )
  .addNode(
    "chief_complaint_generate",
    traceNode(
      "chief_complaint_generate",
      generateChiefComplaint,
      "Generating chief complaint"
    )
  )
  .addNode(
    "anamnesis_generate",
    traceNode("anamnesis_generate", generateAnamnesis, "Generating anamnesis")
  )
  .addNode(
    "case_fan_in",
    traceNode(
      "case_fan_in",
      passthrough<GenerationGraphState>,
      "Assembling case fields"
    )
  )

  .addEdge(START, "case_outline_generate")
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
  .addEdge("case_fan_in", END)
  .compile();
