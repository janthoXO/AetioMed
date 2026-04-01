import { END, START, StateGraph } from "@langchain/langgraph";
import { GlobalStateSchema } from "../state.js";
import z from "zod";
import { SymptomsRelatedToDiseaseIcd } from "@/03repo/symptoms.repo.js";
import { generateSymptomsOneShot } from "@/03aigateway/symptoms.aigateway.js";
import { RequestContextSchema, type RequestContext } from "@/utils/context.js";
import type { Runtime } from "@langchain/langgraph";

const SymptomsGraphStateSchema = GlobalStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  symptoms: true,
});

type SymptomsGraphState = z.infer<typeof SymptomsGraphStateSchema>;

function retrieveSymptomsUMLS(
  state: SymptomsGraphState,
  runtime?: Runtime<RequestContext>
): Pick<SymptomsGraphState, "symptoms"> {
  if (!state.diagnosis.icd) {
    return { symptoms: state.symptoms };
  }

  runtime?.context?.traceUtils?.emitTrace(
    `[SymptomsGraph] Retrieving symptoms from UMLS for ICD ${state.diagnosis.icd}...`
  );

  state.symptoms = SymptomsRelatedToDiseaseIcd(state.diagnosis.icd);

  runtime?.context?.traceUtils?.emitTrace(
    `[SymptomsGraph] Retrieved symptoms from UMLS:\n${
      state.symptoms.length > 0
        ? state.symptoms.map((s) => s.name).join(", ")
        : "none"
    }`
  );
  return { symptoms: state.symptoms };
}

async function generateSymptoms(
  state: SymptomsGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SymptomsGraphState, "symptoms">> {
  runtime?.context?.traceUtils?.emitTrace(
    "[SymptomsGraph] Generating symptoms with LLM..."
  );
  state.symptoms = await generateSymptomsOneShot(
    state.diagnosis,
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    state.symptoms,
    runtime?.context
  );

  runtime?.context?.traceUtils?.emitTrace(
    `[SymptomsGraph] Generated symptoms with LLM:\n${state.symptoms
      .map((s) => s.name)
      .join(", ")}`
  );
  return { symptoms: state.symptoms };
}

export const symptomsGraph = new StateGraph(
  SymptomsGraphStateSchema,
  RequestContextSchema
)
  .addNode("symptoms_umls", retrieveSymptomsUMLS)
  .addNode("symptoms_generate", generateSymptoms)

  .addEdge(START, "symptoms_umls")
  .addEdge("symptoms_umls", "symptoms_generate")
  .addEdge("symptoms_generate", END)
  .compile();
