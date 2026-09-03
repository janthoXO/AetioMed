import { END, START, StateGraph, type Runtime } from "@langchain/langgraph";
import { CaseGenerationStateSchema } from "../state.js";
import z from "zod";
import { bus } from "@/core/graph/index.js";
import {
  SymptomsRelatedToDiagnosisIcd,
  getCachedSymptoms,
  saveCachedSymptoms,
} from "@/core/graph/03repo/symptoms.repo.js";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/core/graph/utils/context.js";
import { symptomTools } from "./tools.js";
import { traceNode } from "@/core/graph/utils/nodeWrapper.js";
import { renderUserInstructions } from "@/core/graph/utils/prompt.js";

const SymptomsGraphStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  symptoms: true,
});

type SymptomsGraphState = z.infer<typeof SymptomsGraphStateSchema>;

// ─── node: retrieve UMLS floor, then resolve LLM additions cache-aside ──────
//
// The UMLS list is read live every time (it's a static, in-memory lookup).
// The LLM-generated additions are cached per ICD code: a fresh cache hit
// skips the LLM call entirely; a miss or stale entry regenerates and writes
// back to the cache. Diagnoses without an ICD code are never cached.

async function retrieveOrGenerateSymptoms(
  state: SymptomsGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<SymptomsGraphState, "symptoms">> {
  const icd = state.diagnosis.icd;
  const umls = icd ? SymptomsRelatedToDiagnosisIcd(icd) : [];

  bus.emit("Generation Log", {
    msg: `[SymptomsGraph] UMLS symptoms: ${
      umls.length > 0 ? umls.map((s) => s.name).join(", ") : "none"
    }`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  const cached = icd ? getCachedSymptoms(icd) : undefined;
  if (cached) {
    bus.emit("Generation Log", {
      msg: `[SymptomsGraph] cache hit for ICD ${icd}: ${cached.map((s) => s.name).join(", ")}`,
      logLevel: "info",
      timestamp: new Date().toISOString(),
    });
    return { symptoms: [...umls, ...cached] };
  }

  // Pass the UMLS floor as symptomsToExclude so the LLM generates novel,
  // non-duplicate symptoms.
  const generated = await symptomTools.generateSymptoms.invoke(
    {
      diagnosis: state.diagnosis,
      symptomsToExclude: umls,
      userInstructions: renderUserInstructions(state.userInstructions),
    },
    runtime?.context
  );

  bus.emit("Generation Log", {
    msg: `[SymptomsGraph] cache miss${icd ? ` for ICD ${icd}` : ""}, LLM symptoms: ${generated.map((s) => s.name).join(", ")}`,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  if (icd) {
    saveCachedSymptoms(icd, generated);
  }

  return { symptoms: [...umls, ...generated] };
}

// ─── graph ────────────────────────────────────────────────────────────────────

export const symptomsGraph = new StateGraph(
  SymptomsGraphStateSchema,
  RequestContextSchema
)
  .addNode(
    "symptoms_resolve",
    traceNode(
      "symptoms_resolve",
      retrieveOrGenerateSymptoms,
      "Retrieving or generating symptoms"
    )
  )

  .addEdge(START, "symptoms_resolve")
  .addEdge("symptoms_resolve", END)
  .compile();
