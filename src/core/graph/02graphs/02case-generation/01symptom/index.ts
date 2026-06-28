import { END, START, StateGraph, type Runtime } from "@langchain/langgraph";
import { CaseGenerationStateSchema } from "../state.js";
import z from "zod";
import { bus } from "@/core/graph/index.js";
import { SymptomsRelatedToDiagnosisIcd } from "@/core/graph/03repo/symptoms.repo.js";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/core/graph/utils/context.js";
import { symptomTools } from "./tools.js";
import { traceNode } from "@/core/graph/utils/nodeWrapper.js";

const SymptomsGraphStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  symptoms: true,
});

type SymptomsGraphState = z.infer<typeof SymptomsGraphStateSchema>;

// ─── node 1: retrieve from UMLS lookup ───────────────────────────────────────

function retrieveSymptomsUMLS(
  state: SymptomsGraphState
): Pick<SymptomsGraphState, "symptoms"> {
  if (!state.diagnosis.icd) {
    return { symptoms: [] };
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

// ─── node 2: generate via LLM and merge with UMLS ────────────────────────────

async function generateAndMergeSymptoms(
  state: SymptomsGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SymptomsGraphState, "symptoms">> {
  // state.symptoms at this point contains the UMLS-retrieved set from node 1.
  // Pass it as symptomsToExclude so the LLM generates novel, non-duplicate symptoms.
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

  // Return UMLS + generated combined
  return { symptoms: [...state.symptoms, ...generated] };
}

// ─── graph ────────────────────────────────────────────────────────────────────

export const symptomsGraph = new StateGraph(
  SymptomsGraphStateSchema,
  RequestContextSchema
)
  .addNode(
    "symptoms_retrieve",
    traceNode(
      "symptoms_retrieve",
      retrieveSymptomsUMLS,
      "Retrieving symptoms from UMLS"
    )
  )
  .addNode(
    "symptoms_generate",
    traceNode(
      "symptoms_generate",
      generateAndMergeSymptoms,
      "Generating and merging symptoms"
    )
  )

  .addEdge(START, "symptoms_retrieve")
  .addEdge("symptoms_retrieve", "symptoms_generate")
  .addEdge("symptoms_generate", END)
  .compile();
