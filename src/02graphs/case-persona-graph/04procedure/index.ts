import { END, START, StateGraph } from "@langchain/langgraph";
import { GlobalStateSchema } from "../state.js";
import z from "zod";
import {
  generateProceduresCoT as generateProceduresCoTService,
  generateProceduresOneShot,
} from "@/03aigateway/procedures.aigateway.js";
import { emitTrace } from "@/utils/tracing.js";

const ProcedureGraphStateSchema = GlobalStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  case: true,
  symptoms: true,
}).extend({
  cot: z.string(),
});

type ProcedureGraphState = z.infer<typeof ProcedureGraphStateSchema>;

async function generateProcedureCoT(
  state: ProcedureGraphState
): Promise<Pick<ProcedureGraphState, "cot">> {
  emitTrace(
    "[ProcedureGraph] Starting generation of Chain of Thought for procedures..."
  );
  state.cot = await generateProceduresCoTService(
    state.diagnosis,
    state.symptoms,
    state.case,
    state.userInstructions
  ).catch((error) => {
    emitTrace(
      `[ProcedureGraph] Error generating Chain of Thought for procedures: ${error}`,
      { category: "error" }
    );
    throw error;
  });

  emitTrace(
    `[ProcedureGraph] Successfully generated Chain of Thought for procedures:\n${state.cot}`
  );
  return { cot: state.cot };
}

async function generateProcedure(
  state: ProcedureGraphState
): Promise<Pick<ProcedureGraphState, "case">> {
  emitTrace("[ProcedureGraph] Starting generation of procedures...");
  if (!state.case) {
    state.case = {};
  }
  state.case.procedures = await generateProceduresOneShot(
    state.diagnosis,
    state.symptoms,
    state.case,
    state.cot,
    state.userInstructions
  ).catch((error) => {
    emitTrace(`[ProcedureGraph] Error generating procedures: ${error}`, {
      category: "error",
    });
    throw error;
  });

  emitTrace(
    `[ProcedureGraph] Successfully generated procedures: ${state.case.procedures
      .map((p) => p.name)
      .join(", ")}`
  );

  return { case: state.case };
}

export const procedureGraph = new StateGraph(ProcedureGraphStateSchema)
  .addNode("procedure_cot_generate", generateProcedureCoT)
  .addNode("procedure_generate", generateProcedure)

  .addEdge(START, "procedure_cot_generate")
  .addEdge("procedure_cot_generate", "procedure_generate")
  .addEdge("procedure_generate", END)
  .compile();
