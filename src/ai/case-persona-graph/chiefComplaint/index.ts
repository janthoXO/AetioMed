import { END, START, StateGraph } from "@langchain/langgraph";
import { GlobalStateSchema } from "../state.js";
import z from "zod";
import {
  generateChiefComplaintCoT as generateChiefComplaintCoTService,
  generateChiefComplaintOneShot,
} from "@/services/chiefComplaint.service.js";

const ChiefComplaintGraphStateSchema = GlobalStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  case: true,
  symptoms: true,
}).extend({
  cot: z.string(),
});

type ChiefComplaintGraphState = z.infer<typeof ChiefComplaintGraphStateSchema>;

async function generateChiefComplaintCoT(
  state: ChiefComplaintGraphState
): Promise<Pick<ChiefComplaintGraphState, "cot">> {
  console.debug(
    "[ChiefComplaintGraph: generateChiefComplaintCoT] Generating chief complaint CoT with LLM..."
  );
  state.cot = await generateChiefComplaintCoTService(
    state.diagnosis,
    state.symptoms,
    state.case,
    state.userInstructions
  );
  return { cot: state.cot };
}

async function generateChiefComplaint(
  state: ChiefComplaintGraphState
): Promise<Pick<ChiefComplaintGraphState, "case">> {
  console.debug(
    "[ChiefComplaintGraph: generateChiefComplaint] Generating chief complaint with LLM..."
  );
  if (!state.case) {
    state.case = {};
  }
  state.case.chiefComplaint = await generateChiefComplaintOneShot(
    state.diagnosis,
    state.symptoms,
    state.case,
    state.cot,
    state.userInstructions
  );
  return { case: state.case };
}

export const chiefComplaintGraph = new StateGraph(
  ChiefComplaintGraphStateSchema
)
  .addNode("chief_complaint_cto_generate", generateChiefComplaintCoT)
  .addNode("chief_complaint_generate", generateChiefComplaint)

  .addEdge(START, "chief_complaint_cto_generate")
  .addEdge("chief_complaint_cto_generate", "chief_complaint_generate")
  .addEdge("chief_complaint_generate", END)
  .compile();
