import { END, START, StateGraph, type Runtime } from "@langchain/langgraph";
import { bus } from "@/core/graph/index.js";
import { CaseGenerationStateSchema } from "./state.js";
import z from "zod";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/core/graph/utils/context.js";
import { symptomsGraph } from "./01symptom/index.js";
import { multiFieldGraph } from "./02multifield/index.js";
import { generationTools } from "./tools.js";
import { PredefinedProcedureNames } from "@/core/graph/models/Procedure.js";
import { traceNode } from "@/core/graph/utils/nodeWrapper.js";
import type { PickNested } from "@/core/graph/utils/pickNested.js";

type CaseGenerationState = z.infer<typeof CaseGenerationStateSchema>;

// ─── procedures node ──────────────────────────────────────────────────────────

async function generateProcedures(
  state: CaseGenerationState,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<CaseGenerationState, "case", "procedures">> {
  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[CaseGenerationGraph] Generating procedures…`,
  });
  const procedures = await generationTools.generateProceduresFromCase
    .invoke(
      {
        diagnosis: state.diagnosis,
        case: state.case,
        procedureNameList: PredefinedProcedureNames,
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
        msg: `[CaseGenerationGraph] Error generating procedures: ${error}`,
      });
      throw error;
    });

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[CaseGenerationGraph] Procedures generated:\n\`\`\`json\n${JSON.stringify(procedures, null, 2)}\n\`\`\``,
  });
  return { case: { procedures } };
}

// ─── graph ────────────────────────────────────────────────────────────────────

export const caseGenerationGraph = new StateGraph(
  CaseGenerationStateSchema,
  RequestContextSchema
)
  .addNode("symptom_phase", symptomsGraph)
  .addNode("multi_field_phase", multiFieldGraph)
  .addNode(
    "procedures_phase",
    traceNode("procedures_phase", generateProcedures, "Generating procedures")
  )

  .addEdge(START, "symptom_phase")
  .addEdge("symptom_phase", "multi_field_phase")
  .addConditionalEdges(
    "multi_field_phase",
    (state) =>
      state.generationFlags.includes("procedures") ? "generate" : "skip",
    { generate: "procedures_phase", skip: END }
  )
  .addEdge("procedures_phase", END)
  .compile();
