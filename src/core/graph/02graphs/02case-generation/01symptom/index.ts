import { END, START, StateGraph } from "@langchain/langgraph";
import { CaseGenerationStateSchema } from "../state.js";
import z from "zod";
import { bus } from "@/core/graph/index.js";
import { SymptomsRelatedToDiagnosisIcd } from "@/core/graph/03repo/symptoms.repo.js";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/core/graph/utils/context.js";
import type { Runtime } from "@langchain/langgraph";
import { symptomTools } from "./tools.js";
import { traceNode } from "@/core/graph/utils/nodeWrapper.js";

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

  const retrieved = SymptomsRelatedToDiagnosisIcd(state.diagnosis.icd);

  bus.emit("Generation Log", {
    msg: `[SymptomsGraph] UMLS symptoms: ${
      retrieved.length > 0 ? retrieved.map((s) => s.name).join(", ") : "none"
    }`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  return { symptoms: retrieved };
}

async function generateSymptoms(
  state: SymptomsGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SymptomsGraphState, "symptoms">> {
  const generated = await symptomTools.generateSymptoms.invoke(
    {
      diagnosis: state.diagnosis,
      symptomsToExclude: state.symptoms,
      userInstructions: state.userInstructions
        ? JSON.stringify(state.userInstructions)
        : undefined,
    },
    runtime?.context
  );

  bus.emit("Generation Log", {
    msg: `[SymptomsGraph] LLM symptoms: ${generated.map((s) => s.name).join(", ")}`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  return { symptoms: generated };
}

export const symptomsGraph = new StateGraph(
  SymptomsGraphStateSchema,
  RequestContextSchema
)
  .addNode(
    "symptoms_umls",
    traceNode(
      "symptoms_umls",
      retrieveSymptomsUMLS,
      "Retrieving symptoms from UMLS"
    )
  )
  .addNode(
    "symptoms_generate",
    traceNode(
      "symptoms_generate",
      generateSymptoms,
      "Generating relevant symptoms"
    )
  )

  .addEdge(START, "symptoms_umls")
  .addEdge("symptoms_umls", "symptoms_generate")
  .addEdge("symptoms_generate", END)
  .compile();
