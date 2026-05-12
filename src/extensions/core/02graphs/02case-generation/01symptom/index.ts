import { END, START, StateGraph } from "@langchain/langgraph";
import { CaseGenerationStateSchema } from "../state.js";
import z from "zod";
import { bus } from "@/extensions/core/index.js";
import { SymptomsRelatedToDiagnosisIcd } from "@/extensions/core/03repo/symptoms.repo.js";
import { generateSymptomsOneShot } from "@/extensions/core/03aigateway/symptoms.aigateway.js";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/extensions/core/utils/context.js";
import type { Runtime } from "@langchain/langgraph";

const SymptomsGraphStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  symptoms: true,
});

type SymptomsGraphState = z.infer<typeof SymptomsGraphStateSchema>;

function retrieveSymptomsUMLS(
  state: SymptomsGraphState
): Pick<SymptomsGraphState, "symptoms"> {
  if (!state.diagnosis.icd) {
    return { symptoms: state.symptoms };
  }

  bus.emit("Generation Log", {
    msg: `[SymptomsGraph] Retrieving symptoms from UMLS for ICD ${state.diagnosis.icd}...`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  const retrievedSymptoms = SymptomsRelatedToDiagnosisIcd(state.diagnosis.icd);

  bus.emit("Generation Log", {
    msg: `[SymptomsGraph] Retrieved symptoms from UMLS:\n${
      retrievedSymptoms.length > 0
        ? retrievedSymptoms.map((s) => s.name).join(", ")
        : "none"
    }`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  return { symptoms: retrievedSymptoms };
}

async function generateSymptoms(
  state: SymptomsGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SymptomsGraphState, "symptoms">> {
  bus.emit("Generation Log", {
    msg: "[SymptomsGraph] Generating symptoms with LLM...",
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  const generatedSymptoms = await generateSymptomsOneShot(
    state.diagnosis,
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    state.symptoms,
    runtime?.context
  );

  bus.emit("Generation Log", {
    msg: `[SymptomsGraph] Generated symptoms with LLM:\n${generatedSymptoms
      .map((s) => s.name)
      .join(", ")}`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  return { symptoms: generatedSymptoms };
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
