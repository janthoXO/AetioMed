import { END, START, StateGraph } from "@langchain/langgraph";
import { GlobalStateSchema } from "../state.js";
import z from "zod";
import {
  generateProceduresCoT as generateProceduresCoTService,
  generateProceduresOneShot,
} from "@/03aigateway/procedures.aigateway.js";
import { PredefinedProcedures } from "@/models/Procedure.js";

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
  console.debug(
    "[ProcedureGraph: generateProcedureCoT] Generating procedure CoT with LLM..."
  );
  state.cot = await generateProceduresCoTService(
    state.diagnosis,
    state.symptoms,
    state.case,
    state.userInstructions
  );
  return { cot: state.cot };
}

async function generateProcedure(
  state: ProcedureGraphState
): Promise<Pick<ProcedureGraphState, "case">> {
  console.debug(
    "[ProcedureGraph: generateProcedure] Generating procedures with LLM..."
  );
  if (!state.case) {
    state.case = {};
  }
  state.case.procedures = await generateProceduresOneShot(
    state.diagnosis,
    state.symptoms,
    state.case,
    state.cot,
    state.userInstructions
  );

  // map generated to procedures to predefined procedures as good as possible
  if (PredefinedProcedures) {
    state.case.procedures = state.case.procedures
      .map((p) => {
        const predefined = PredefinedProcedures!.find((pre) =>
          pre.name.toLowerCase().includes(p.name.toLowerCase())
        );
        return predefined
          ? {
              ...p,
              name: predefined.name,
            }
          : undefined;
      })
      .filter((p) => !!p);
  }
  return { case: state.case };
}

export const procedureGraph = new StateGraph(ProcedureGraphStateSchema)
  .addNode("procedure_cot_generate", generateProcedureCoT)
  .addNode("procedure_generate", generateProcedure)

  .addEdge(START, "procedure_cot_generate")
  .addEdge("procedure_cot_generate", "procedure_generate")
  .addEdge("procedure_generate", END)
  .compile();
