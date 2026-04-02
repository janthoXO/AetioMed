import {
  END,
  Send,
  START,
  StateGraph,
  type Runtime,
} from "@langchain/langgraph";
import { CaseGenerationStateSchema } from "../../state.js";
import z from "zod";
import { generateChiefComplaint as generateChiefComplaintGateway } from "@/03aigateway/chiefComplaint.aigateway.js";
import {
  generateCaseCoT as generateCaseCoTGateway,
  generateCaseOutline as generateCaseOutlineGateway,
} from "@/03aigateway/case.aigateway.js";
import { RequestContextSchema, type RequestContext } from "@/utils/context.js";
import { generatePatient as generatePatientGateway } from "@/03aigateway/patient.aigateway.js";
import { generateAnamnesis as generateAnamnesisGateway } from "@/03aigateway/anamnesis.aigateway.js";
import { generateProcedures as generateProceduresGateway } from "@/03aigateway/procedures.aigateway.js";
import { passthrough } from "@/02graphs/graph.utils.js";
import type { PickNested } from "@/utils/pickNested.js";

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
  state.cot = await generateCaseCoTGateway(
    state.diagnosis,
    state.generationFlags,
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
    runtime?.context?.traceUtils?.emitTrace(
      `[GenerationGraph] Error generating case CoT: ${error}`,
      {
        category: "error",
      }
    );
    throw error;
  });

  runtime?.context?.traceUtils
    ?.emitTrace(`[GenerationGraph] Successfully generated case CoT:
${state.cot}`);

  return { cot: state.cot };
}

async function generateCaseOutline(
  state: GenerationGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<GenerationGraphState, "outline">> {
  state.outline = await generateCaseOutlineGateway(
    state.diagnosis,
    state.generationFlags,
    state.symptoms,
    state.cot,
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
    runtime?.context?.traceUtils?.emitTrace(
      `[GenerationGraph] Error generating case outline: ${error}`,
      {
        category: "error",
      }
    );
    throw error;
  });

  runtime?.context?.traceUtils?.emitTrace(
    `[GenerationGraph] Successfully generated case outline:
${state.outline}`
  );

  return { outline: state.outline };
}

async function generatePatient(
  state: GenerationGraphState,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<GenerationGraphState, "case", "patient">> {
  runtime?.context?.traceUtils?.emitTrace(
    `[GenerationGraph] Starting generation of patient fields...`
  );
  const generatedPatient = await generatePatientGateway(
    state.diagnosis,
    {
      outline: state.outline,
    },
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
    runtime?.context?.traceUtils?.emitTrace(
      `[GenerationGraph] Error generating patient: ${error}`,
      {
        category: "error",
      }
    );
    throw error;
  });

  runtime?.context?.traceUtils?.emitTrace(
    `[GenerationGraph] Successfully generated patient:
\`\`\`json
${JSON.stringify(state.case.patient, null, 2)}
\`\`\``
  );

  return { case: { patient: generatedPatient } };
}

async function generateChiefComplaint(
  state: GenerationGraphState,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<GenerationGraphState, "case", "chiefComplaint">> {
  runtime?.context?.traceUtils?.emitTrace(
    `[GenerationGraph] Starting generation of chief complaint...`
  );
  const generatedChiefComplaint = await generateChiefComplaintGateway(
    state.diagnosis,
    {
      outline: state.outline,
    },
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
    runtime?.context?.traceUtils?.emitTrace(
      `[GenerationGraph] Error generating chief complaint: ${error}`,
      {
        category: "error",
      }
    );
    throw error;
  });

  runtime?.context?.traceUtils?.emitTrace(
    `[GenerationGraph] Successfully generated chief complaint:
${state.case.chiefComplaint}`
  );

  return { case: { chiefComplaint: generatedChiefComplaint } };
}

async function generateAnamnesis(
  state: GenerationGraphState,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<GenerationGraphState, "case", "anamnesis">> {
  runtime?.context?.traceUtils?.emitTrace(
    `[GenerationGraph] Starting generation of anamnesis fields...`
  );
  const generatedAnamnesis = await generateAnamnesisGateway(
    state.diagnosis,
    {
      outline: state.outline,
    },
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    state.anamnesisCategories,
    runtime?.context
  ).catch((error) => {
    runtime?.context?.traceUtils?.emitTrace(
      `[GenerationGraph] Error generating anamnesis: ${error}`,
      {
        category: "error",
      }
    );
    throw error;
  });

  runtime?.context?.traceUtils?.emitTrace(
    `[GenerationGraph] Successfully generated anamnesis:
\`\`\`json
${JSON.stringify(state.case.anamnesis, null, 2)}
\`\`\``
  );

  return { case: { anamnesis: generatedAnamnesis } };
}

async function generateProcedures(
  state: GenerationGraphState,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<GenerationGraphState, "case", "procedures">> {
  runtime?.context?.traceUtils?.emitTrace(
    `[GenerationGraph] Starting generation of procedures...`
  );
  const generatedProcedures = await generateProceduresGateway(
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
      : undefined,
    undefined,
    runtime?.context
  ).catch((error) => {
    runtime?.context?.traceUtils?.emitTrace(
      `[GenerationGraph] Error generating procedures: ${error}`,
      {
        category: "error",
      }
    );
    throw error;
  });

  runtime?.context?.traceUtils?.emitTrace(
    `[GenerationGraph] Successfully generated procedures:
\`\`\`json
${JSON.stringify(state.case.procedures, null, 2)}
\`\`\``
  );

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
