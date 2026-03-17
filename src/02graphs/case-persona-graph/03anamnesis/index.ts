import { END, START, StateGraph } from "@langchain/langgraph";
import { GlobalStateSchema } from "../state.js";
import z from "zod";
import {
  generateAnamnesisCoT as generateAnamnesisCoTService,
  generateAnamnesisOneShot,
} from "@/03aigateway/anamnesis.aigateway.js";
import { emitTrace } from "@/utils/tracing.js";

const AnamnesisGraphStateSchema = GlobalStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  anamnesisCategories: true,
  case: true,
  symptoms: true,
}).extend({
  cot: z.string(),
});

type AnamnesisGraphState = z.infer<typeof AnamnesisGraphStateSchema>;

async function generateAnamnesisCoT(
  state: AnamnesisGraphState
): Promise<Pick<AnamnesisGraphState, "cot">> {
  emitTrace(
    "[AnamnesisGraph] Starting generation of Chain of Thought for anamnesis..."
  );
  state.cot = await generateAnamnesisCoTService(
    state.diagnosis,
    state.symptoms,
    state.case,
    state.userInstructions
  ).catch((error) => {
    emitTrace(
      `[AnamnesisGraph] Error generating Chain of Thought for anamnesis: ${error}`,
      { category: "error" }
    );
    throw error;
  });

  emitTrace(
    `[AnamnesisGraph] Successfully generated Chain of Thought for anamnesis:\n${state.cot}`
  );
  return { cot: state.cot };
}

async function generateAnamnesis(
  state: AnamnesisGraphState
): Promise<Pick<AnamnesisGraphState, "case">> {
  emitTrace("[AnamnesisGraph] Starting generation for anamnesis...");
  if (!state.case) {
    state.case = {};
  }
  state.case.anamnesis = await generateAnamnesisOneShot(
    state.diagnosis,
    state.symptoms,
    state.case,
    state.cot,
    state.userInstructions,
    state.anamnesisCategories
  ).catch((error) => {
    emitTrace(`[AnamnesisGraph] Error generating anamnesis: ${error}`, {
      category: "error",
    });
    throw error;
  });

  emitTrace(
    `[AnamnesisGraph] Successfully generated anamnesis: ${JSON.stringify(state.case.anamnesis, null, 2)}`
  );

  return { case: state.case };
}

export const anamnesisGraph = new StateGraph(AnamnesisGraphStateSchema)
  .addNode("anamnesis_cot_generate", generateAnamnesisCoT)
  .addNode("anamnesis_generate", generateAnamnesis)

  .addEdge(START, "anamnesis_cot_generate")
  .addEdge("anamnesis_cot_generate", "anamnesis_generate")
  .addEdge("anamnesis_generate", END)
  .compile();
