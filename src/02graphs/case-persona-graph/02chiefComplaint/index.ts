import { END, START, StateGraph } from "@langchain/langgraph";
import { GlobalStateSchema } from "../state.js";
import z from "zod";
import {
  generateChiefComplaintCoT as generateChiefComplaintCoTService,
  generateChiefComplaintOneShot,
} from "@/03aigateway/chiefComplaint.aigateway.js";
import { emitTrace } from "@/utils/tracing.js";

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
  emitTrace(
    `[ChiefComplaintGraph] Starting generation of chain of thought for chief complaint...`
  );
  state.cot = await generateChiefComplaintCoTService(
    state.diagnosis,
    state.symptoms,
    state.case,
    state.userInstructions
  ).catch((error) => {
    emitTrace(
      `[ChiefComplaintGraph] Error generating chain of thought for chief complaint: ${error}`,
      { category: "error" }
    );
    throw error;
  });

  emitTrace(
    `[ChiefComplaintGraph] Successfully generated chain of thought for chief complaint:\n${state.cot}`
  );

  return { cot: state.cot };
}

async function generateChiefComplaint(
  state: ChiefComplaintGraphState
): Promise<Pick<ChiefComplaintGraphState, "case">> {
  emitTrace(`[ChiefComplaintGraph] Starting generation of chief complaint...`);
  if (!state.case) {
    state.case = {};
  }
  state.case.chiefComplaint = await generateChiefComplaintOneShot(
    state.diagnosis,
    state.symptoms,
    state.case,
    state.cot,
    state.userInstructions
  ).catch((error) => {
    emitTrace(
      `[ChiefComplaintGraph] Error generating chief complaint: ${error}`,
      { category: "error" }
    );
    throw error;
  });

  emitTrace(
    `[ChiefComplaintGraph] Successfully generated chief complaint: ${state.case.chiefComplaint}`
  );

  return { case: state.case };
}

export const chiefComplaintGraph = new StateGraph(
  ChiefComplaintGraphStateSchema
)
  .addNode("chief_complaint_cot_generate", generateChiefComplaintCoT)
  .addNode("chief_complaint_generate", generateChiefComplaint)

  .addEdge(START, "chief_complaint_cot_generate")
  .addEdge("chief_complaint_cot_generate", "chief_complaint_generate")
  .addEdge("chief_complaint_generate", END)
  .compile();
