import {
  END,
  Send,
  START,
  StateGraph,
  type Runtime,
} from "@langchain/langgraph";
import { bus } from "@/extensions/core/index.js";
import { CaseGenerationStateSchema } from "../../state.js";
import z from "zod";
import { generateChiefComplaint as generateChiefComplaintGateway } from "@/extensions/core/03aigateway/chiefComplaint.aigateway.js";
import {
  generateCaseCoT as generateCaseCoTGateway,
  generateCaseOutline as generateCaseOutlineGateway,
} from "@/extensions/core/03aigateway/case.aigateway.js";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/extensions/core/utils/context.js";
import { generatePatient as generatePatientGateway } from "@/extensions/core/03aigateway/patient.aigateway.js";
import { generateAnamnesis as generateAnamnesisGateway } from "@/extensions/core/03aigateway/anamnesis.aigateway.js";
import { generateProcedures as generateProceduresGateway } from "@/extensions/core/03aigateway/procedures.aigateway.js";
import { passthrough } from "@/extensions/core/02graphs/graph.utils.js";
import type { PickNested } from "@/extensions/core/utils/pickNested.js";

const GenerationGraphStateSchema = CaseGenerationStateSchema.extend({
  cot: z.string(),

  /**
   * Generated outline for the case.
   */
  outline: z.string(),
});

type GenerationGraphState = z.infer<typeof GenerationGraphStateSchema>;

async function generateCaseCoT(
  state: GenerationGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<GenerationGraphState, "cot">> {
  const generatedCoT = await generateCaseCoTGateway(
    state.diagnosis,
    state.generationFlags.filter((f) => f !== "procedures"),
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
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
    msg: `[GenerationGraph] Successfully generated case CoT:\n\`\`\` ${generatedCoT}\`\`\``,
  });

  return { cot: generatedCoT };
}

async function generateCaseOutline(
  state: GenerationGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<GenerationGraphState, "outline">> {
  const generatedOutline = await generateCaseOutlineGateway(
    state.diagnosis,
    state.generationFlags.filter((f) => f !== "procedures"),
    state.symptoms,
    state.cot,
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
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
    msg: `[GenerationGraph] Successfully generated case outline:\n\`\`\` ${generatedOutline}\`\`\``,
  });

  return { outline: generatedOutline };
}

async function generatePatient(
  state: GenerationGraphState,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<GenerationGraphState, "case", "patient">> {
  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Starting generation of patient fields...`,
  });
  const generatedPatient = await generatePatientGateway(
    state.diagnosis,
    {
      outline: state.outline,
    },
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
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
    msg: `[GenerationGraph] Successfully generated patient:\n\`\`\`json\n${JSON.stringify(generatedPatient, null, 2)}\n\`\`\``,
  });

  return { case: { patient: generatedPatient } };
}

async function generateChiefComplaint(
  state: GenerationGraphState,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<GenerationGraphState, "case", "chiefComplaint">> {
  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Starting generation of chief complaint...`,
  });
  const generatedChiefComplaint = await generateChiefComplaintGateway(
    state.diagnosis,
    {
      outline: state.outline,
    },
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
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
    msg: `[GenerationGraph] Successfully generated chief complaint:\n\`\`\` ${generatedChiefComplaint}\`\`\``,
  });

  return { case: { chiefComplaint: generatedChiefComplaint } };
}

async function generateAnamnesis(
  state: GenerationGraphState,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<GenerationGraphState, "case", "anamnesis">> {
  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Starting generation of anamnesis fields...`,
  });
  const generatedAnamnesis = await generateAnamnesisGateway(
    state.diagnosis,
    {
      outline: state.outline,
    },
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    state.anamnesisCategories,
    runtime?.context
  ).catch((error) => {
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
    msg: `[GenerationGraph] Successfully generated anamnesis:\n\`\`\`json\n${JSON.stringify(state.case.anamnesis, null, 2)}\n\`\`\``,
  });

  return { case: { anamnesis: generatedAnamnesis } };
}

async function generateProcedures(
  state: GenerationGraphState,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<GenerationGraphState, "case", "procedures">> {
  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Starting generation of procedures...`,
  });
  const generatedProcedures = await generateProceduresGateway(
    state.diagnosis,
    {
      case: state.case,
    },
    state.userInstructions
      ? JSON.stringify(
          Object.entries(state.userInstructions).filter(
            ([key]) => key === "procedures" || key === "general"
          )
        )
      : undefined,
    undefined,
    runtime?.context
  ).catch((error) => {
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
    msg: `[GenerationGraph] Successfully generated procedures:\n\`\`\`json\n${JSON.stringify(generatedProcedures, null, 2)}\n\`\`\``,
  });

  return { case: { procedures: generatedProcedures } };
}

export const fieldGenerationGraph = new StateGraph(
  GenerationGraphStateSchema,
  RequestContextSchema
)
  .addNode("case_cot_generate", generateCaseCoT)
  .addNode("case_outline_generate", generateCaseOutline)
  .addNode("patient_generate", generatePatient)
  .addNode("chief_complaint_generate", generateChiefComplaint)
  .addNode("anamnesis_generate", generateAnamnesis)
  .addNode("case_fan_in", passthrough<GenerationGraphState>)
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
              : "",
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
              : "",
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
              : "",
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
